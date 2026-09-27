#!/usr/bin/env bash
# Restore a backup snapshot into a fresh directory and check it.
#
# Usage:
#   bash scripts/restore-drill.sh /path/to/lashkirja-YYYY-MM-DD-HHMMSS
#
# The snapshot is the directory written by scripts/backup-db.sh:
#   lashkirja.db, uploads/, MANIFEST.txt
#
# The script copies those into a new temporary directory, runs
# PRAGMA integrity_check, and checks the manifest hash and upload count.
# It prints the restored path. Set LASHKIRJA_RESTORE_CLEAN=1 to delete that
# directory after a successful check.
#
# Optional:
#   LASHKIRJA_RESTORE_SQL   a query that must return exactly one non-empty line
#                           (for example: SELECT email FROM User WHERE id='…')

set -euo pipefail

SNAPSHOT="${1:-}"
if [ -z "$SNAPSHOT" ] || [ ! -f "$SNAPSHOT/lashkirja.db" ]; then
  echo "ERROR: pass a snapshot directory that contains lashkirja.db" >&2
  echo "Usage: bash scripts/restore-drill.sh data/backups/lashkirja-YYYY-MM-DD-HHMMSS" >&2
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "ERROR: sqlite3 is required." >&2
  exit 1
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/lashkirja-restore-XXXXXX")"
mkdir -p "$WORK/data/uploads"
cp "$SNAPSHOT/lashkirja.db" "$WORK/data/lashkirja.db"
if [ -d "$SNAPSHOT/uploads" ]; then
  cp -a "$SNAPSHOT/uploads"/. "$WORK/data/uploads"/
fi

CHECK="$(sqlite3 "$WORK/data/lashkirja.db" "PRAGMA integrity_check;")"
if [ "$CHECK" != "ok" ]; then
  echo "ERROR: restored database failed integrity_check: $CHECK" >&2
  exit 1
fi

if [ -f "$SNAPSHOT/MANIFEST.txt" ]; then
  EXPECT_HASH="$(awk -F= '/^db=/{print $2}' "$SNAPSHOT/MANIFEST.txt")"
  ACTUAL_HASH="$(sha256sum "$WORK/data/lashkirja.db" | awk '{print $1}')"
  if [ -n "$EXPECT_HASH" ] && [ "$EXPECT_HASH" != "$ACTUAL_HASH" ]; then
    echo "ERROR: restored database hash does not match the manifest" >&2
    exit 1
  fi
  EXPECT_UPLOADS="$(awk -F= '/^uploads=/{print $2}' "$SNAPSHOT/MANIFEST.txt")"
  ACTUAL_UPLOADS="$(find "$WORK/data/uploads" -type f | wc -l | tr -d ' ')"
  if [ -n "$EXPECT_UPLOADS" ] && [ "$EXPECT_UPLOADS" != "$ACTUAL_UPLOADS" ]; then
    echo "ERROR: restored upload count $ACTUAL_UPLOADS != manifest $EXPECT_UPLOADS" >&2
    exit 1
  fi
fi

if [ -n "${LASHKIRJA_RESTORE_SQL:-}" ]; then
  ROW="$(sqlite3 "$WORK/data/lashkirja.db" "$LASHKIRJA_RESTORE_SQL")"
  if [ -z "$ROW" ]; then
    echo "ERROR: restore query returned no row: $LASHKIRJA_RESTORE_SQL" >&2
    exit 1
  fi
  echo "row=$ROW"
fi

echo "integrity=ok"
echo "restored=$WORK/data"
echo "Restore drill ok."

if [ "${LASHKIRJA_RESTORE_CLEAN:-}" = "1" ]; then
  rm -rf "$WORK"
fi
