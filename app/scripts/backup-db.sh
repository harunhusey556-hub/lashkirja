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

hash_file() {
  sha256sum "$1" | awk '{print $1}'
}

table_exists() {
  local db="$1" name="$2"
  sqlite3 "$db" "SELECT name FROM sqlite_master WHERE type='table' AND name='$name';" | grep -qx "$name"
}

snapshot_db() {
  sqlite3 "$DB_PATH" ".backup '$1'"
}

copy_uploads() {
  rm -rf "$DEST/uploads"
  mkdir -p "$DEST/uploads"
  if [ -d "$UPLOADS_DIR" ]; then
    cp -a "$UPLOADS_DIR"/. "$DEST/uploads"/
  fi
}

# Signature of the files the snapshot database points at. Two snapshots with
# the same signature mean no receipt or upload row changed while files were copied.
refs_signature() {
  local db="$1"
  if ! table_exists "$db" Upload && ! table_exists "$db" Receipt; then
    echo "none"
    return
  fi
  {
    if table_exists "$db" Upload; then
      sqlite3 "$db" "SELECT 'U|' || userId || '|' || storageKey || '|' || COALESCE(sha256,'') FROM Upload ORDER BY 1;"
    fi
    if table_exists "$db" Receipt; then
      sqlite3 "$db" "SELECT 'R|' || userId || '|' || filePath FROM Receipt ORDER BY 1;"
    fi
  } | sha256sum | awk '{print $1}'
}

# Every upload row must exist in the copied tree and match the stored sha256.
# Receipt file paths that are real storage keys are checked the same way.
reference_check() {
  local db="$1" uploads="$2"
  if table_exists "$db" Upload; then
    while IFS=$'\t' read -r user key sum; do
      [ -z "${key:-}" ] && continue
      local path="$uploads/$user/$key"
      if [ ! -f "$path" ]; then
        path="$uploads/$key"
      fi
      if [ ! -f "$path" ]; then
        echo "ERROR: snapshot database references missing upload $user/$key" >&2
        return 1
      fi
      if [ -n "$sum" ]; then
        local actual
        actual="$(hash_file "$path")"
        if [ "$actual" != "$sum" ]; then
          echo "ERROR: upload $user/$key hash does not match the database" >&2
          return 1
        fi
      fi
    done < <(sqlite3 -separator $'\t' "$db" "SELECT userId, storageKey, COALESCE(sha256,'') FROM Upload;")
  fi
  if table_exists "$db" Receipt; then
    while IFS=$'\t' read -r user file_path; do
      [ -z "${file_path:-}" ] && continue
      case "$file_path" in
        *.*) ;;
        *) continue ;;
      esac
      local path="$uploads/$user/$file_path"
      if [ ! -f "$path" ] && [ ! -f "$uploads/$file_path" ]; then
        echo "ERROR: snapshot database references missing receipt file $user/$file_path" >&2
        return 1
      fi
    done < <(sqlite3 -separator $'\t' "$db" "SELECT userId, filePath FROM Receipt;")
  fi
}

write_manifest() {
  {
    echo "created=$TIMESTAMP"
    echo "db=$(hash_file "$DEST/lashkirja.db")"
    echo "uploads=$(find "$DEST/uploads" -type f | wc -l | tr -d ' ')"
    find "$DEST/uploads" -type f | sort | while read -r file; do
      rel="${file#"$DEST/"}"
      printf 'file\t%s\t%s\n' "$(hash_file "$file")" "$rel"
    done
  } > "$DEST/MANIFEST.txt"
}

# Bracket the file copy with two database snapshots. If the referenced rows
# change, or a file hash does not match the row, copy once more. A second
# mismatch means the app was writing the whole time: stop rather than keep a
# mix of two moments. A quiet database is the freeze.
stable=0
for attempt in 1 2; do
  snapshot_db "$DEST/lashkirja.db"
  CHECK="$(sqlite3 "$DEST/lashkirja.db" "PRAGMA integrity_check;")"
  if [ "$CHECK" != "ok" ]; then
    echo "ERROR: backup integrity_check failed: $CHECK" >&2
    exit 1
  fi
  SIG_BEFORE="$(refs_signature "$DEST/lashkirja.db")"
  copy_uploads
  snapshot_db "$DEST/lashkirja.db.after"
  SIG_AFTER="$(refs_signature "$DEST/lashkirja.db.after")"
  if [ "$SIG_BEFORE" = "$SIG_AFTER" ] && reference_check "$DEST/lashkirja.db" "$DEST/uploads"; then
    rm -f "$DEST/lashkirja.db.after"
    stable=1
    break
  fi
  # The later snapshot saw newer rows. Keep it and try the files again.
  mv "$DEST/lashkirja.db.after" "$DEST/lashkirja.db"
  echo "Backup window moved; retrying the upload copy (attempt $attempt)." >&2
done

if [ "$stable" != "1" ]; then
  echo "ERROR: database and uploads changed during backup. Retry when the app is quiet." >&2
  exit 1
fi

write_manifest

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
