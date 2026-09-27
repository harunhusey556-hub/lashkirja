#!/usr/bin/env bash
# LashKirja backup: one consistent SQLite snapshot plus data/uploads.
#
# sqlite3 .backup reads through the WAL. The script never copies the database
# file and its -wal/-shm siblings one after another.
#
# Usage:
#   bash scripts/backup-db.sh
#
# Optional environment:
#   LASHKIRJA_DB_PATH        default: <app>/data/lashkirja.db
#   LASHKIRJA_UPLOADS_DIR    default: <app>/data/uploads
#   LASHKIRJA_BACKUP_DIR     default: <app>/data/backups
#   LASHKIRJA_BACKUP_KEEP    default: 7
#   LASHKIRJA_BACKUP_REMOTE  rsync destination. A local directory or
#                            user@host:/path. Unset means local only.
#
# Verify a remote copy (local destination):
#   LASHKIRJA_BACKUP_REMOTE=/var/backups/lashkirja bash scripts/backup-db.sh
#   sha256sum data/backups/lashkirja-*/lashkirja.db \
#             /var/backups/lashkirja/lashkirja-*/lashkirja.db
# The two hashes of the newest pair must match, and the remote uploads/
# directory must contain the same filenames.
#
# Verify a remote host:
#   LASHKIRJA_BACKUP_REMOTE=user@backup.example:/var/backups/lashkirja \
#     bash scripts/backup-db.sh
#   ssh user@backup.example 'sha256sum /var/backups/lashkirja/lashkirja-*/lashkirja.db'
#
# Cron: 0 3 * * * cd /path/to/app && bash scripts/backup-db.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DB_PATH="${LASHKIRJA_DB_PATH:-$APP_DIR/data/lashkirja.db}"
UPLOADS_DIR="${LASHKIRJA_UPLOADS_DIR:-$APP_DIR/data/uploads}"
BACKUP_DIR="${LASHKIRJA_BACKUP_DIR:-$APP_DIR/data/backups}"
REMOTE="${LASHKIRJA_BACKUP_REMOTE:-}"
KEEP="${LASHKIRJA_BACKUP_KEEP:-7}"
TIMESTAMP="$(date +%Y-%m-%d-%H%M%S)"
DEST="$BACKUP_DIR/lashkirja-$TIMESTAMP"

if [ ! -f "$DB_PATH" ]; then
  echo "ERROR: Database not found at $DB_PATH" >&2
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "ERROR: sqlite3 is required for a consistent backup. Refusing to copy the database and WAL separately." >&2
  exit 1
fi

mkdir -p "$DEST/uploads"
chmod 700 "$BACKUP_DIR" "$DEST"

# One consistent file. .backup sees committed pages that still live in the WAL.
sqlite3 "$DB_PATH" ".backup '$DEST/lashkirja.db'"

CHECK="$(sqlite3 "$DEST/lashkirja.db" "PRAGMA integrity_check;")"
if [ "$CHECK" != "ok" ]; then
  echo "ERROR: backup integrity_check failed: $CHECK" >&2
  exit 1
fi

if [ -d "$UPLOADS_DIR" ]; then
  cp -a "$UPLOADS_DIR"/. "$DEST/uploads"/
fi

{
  echo "created=$TIMESTAMP"
  echo "db=$(sha256sum "$DEST/lashkirja.db" | awk '{print $1}')"
  echo "uploads=$(find "$DEST/uploads" -type f | wc -l | tr -d ' ')"
} > "$DEST/MANIFEST.txt"

chmod 600 "$DEST/lashkirja.db" "$DEST/MANIFEST.txt"
echo "Backup created: $DEST ($(du -sh "$DEST" | cut -f1))"

# Newest first. Keep snapshot directories and any older lone .db files.
mapfile -t ENTRIES < <(
  find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 \
    \( -type d -name 'lashkirja-*' -o -type f -name 'lashkirja-*.db' \) \
    -printf '%T@ %p\n' | sort -nr | cut -d' ' -f2-
)
if [ "${#ENTRIES[@]}" -gt "$KEEP" ]; then
  for OLD in "${ENTRIES[@]:$KEEP}"; do
    rm -rf "$OLD"
    echo "Removed old backup: $(basename "$OLD")"
  done
fi

if [ -n "$REMOTE" ]; then
  if ! command -v rsync >/dev/null 2>&1; then
    echo "ERROR: LASHKIRJA_BACKUP_REMOTE is set but rsync is not installed." >&2
    exit 1
  fi
  case "$REMOTE" in
    *:*)
      rsync -a "$DEST" "$REMOTE/"
      ;;
    *)
      mkdir -p "$REMOTE"
      rsync -a "$DEST" "$REMOTE/"
      ;;
  esac
  echo "Remote copy: $REMOTE/$(basename "$DEST")"
fi

echo "Done. Backup kept under $DEST (max $KEEP)."
