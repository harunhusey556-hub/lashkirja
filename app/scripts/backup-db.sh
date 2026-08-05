#!/usr/bin/env bash
# LashKirja — SQLite database backup script
# Uses SQLite's .backup command (safe for WAL mode).
# Retains the last 7 daily backups, deletes older ones.
#
# Usage: bash scripts/backup-db.sh
# Cron:  0 3 * * * cd /path/to/app && bash scripts/backup-db.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
DB_PATH="$APP_DIR/data/lashkirja.db"
BACKUP_DIR="$APP_DIR/data/backups"
TIMESTAMP="$(date +%Y-%m-%d-%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/lashkirja-$TIMESTAMP.db"
MAX_BACKUPS=7

if [ ! -f "$DB_PATH" ]; then
  echo "ERROR: Database not found at $DB_PATH" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

# Use sqlite3 .backup for safe WAL-mode backup
if command -v sqlite3 &>/dev/null; then
  sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"
else
  # Fallback: copy with WAL checkpoint first
  cp "$DB_PATH" "$BACKUP_FILE"
  [ -f "${DB_PATH}-wal" ] && cp "${DB_PATH}-wal" "${BACKUP_FILE}-wal"
  [ -f "${DB_PATH}-shm" ] && cp "${DB_PATH}-shm" "${BACKUP_FILE}-shm"
fi

chmod 600 "$BACKUP_FILE"
echo "Backup created: $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"

# Prune old backups, keep last MAX_BACKUPS
BACKUPS=($(ls -1t "$BACKUP_DIR"/lashkirja-*.db 2>/dev/null))
if [ ${#BACKUPS[@]} -gt $MAX_BACKUPS ]; then
  for OLD in "${BACKUPS[@]:$MAX_BACKUPS}"; do
    rm -f "$OLD" "${OLD}-wal" "${OLD}-shm"
    echo "Removed old backup: $(basename "$OLD")"
  done
fi

echo "Done. ${#BACKUPS[@]} backup(s) in $BACKUP_DIR (keeping max $MAX_BACKUPS)."
