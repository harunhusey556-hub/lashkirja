# Backups

`scripts/backup-db.sh` writes one snapshot directory:

```
data/backups/lashkirja-YYYY-MM-DD-HHMMSS/
  lashkirja.db    consistent SQLite snapshot (sqlite3 .backup)
  uploads/        copy of data/uploads
  MANIFEST.txt    sha256 of the database, a file count, and one sha256 per upload file
```

The database copy is a single file. The script does not copy `lashkirja.db-wal` beside it. `sqlite3 .backup` reads committed pages through the WAL, then `PRAGMA integrity_check` must return `ok`. If `sqlite3` is missing the script stops. It will not fall back to copying the database and the WAL one after another.

The upload copy is bracketed by two database snapshots. The script keeps the snapshot only when both name the same upload and receipt files, and each `Upload.sha256` matches the copied bytes. If the app writes during that window, the script copies once more. If the second window still moved, it stops and leaves you to retry when the app is quiet. That quiet window is the freeze: the script does not pause the server.

`MANIFEST.txt` lists `db=<sha256>`, `uploads=<count>`, and one `file<TAB><sha256><TAB>uploads/…` line per file. A restore drill checks every one of those hashes. `LASHKIRJA_RESTORE_FILE` plus `LASHKIRJA_RESTORE_SHA256` checks one known file after the copy, which is the stand-in for opening that receipt's bytes.

The last 7 snapshots are kept. Override with `LASHKIRJA_BACKUP_KEEP`.

## Off-machine copy

Set `LASHKIRJA_BACKUP_REMOTE` to an rsync destination. Leave it unset to keep the copy only on this machine.

Local directory:

```bash
LASHKIRJA_BACKUP_REMOTE=/var/backups/lashkirja bash scripts/backup-db.sh
```

Another host:

```bash
LASHKIRJA_BACKUP_REMOTE=user@backup.example:/var/backups/lashkirja \
  bash scripts/backup-db.sh
```

`rsync` must be installed when the variable is set. The script copies the new snapshot directory. It does not delete older copies on the remote.

## How to verify

After a run, the newest local and remote databases must have the same sha256, and the remote `uploads/` directory must contain the same files.

```bash
sha256sum data/backups/lashkirja-*/lashkirja.db \
          /var/backups/lashkirja/lashkirja-*/lashkirja.db
```

On another host:

```bash
ssh user@backup.example 'sha256sum /var/backups/lashkirja/lashkirja-*/lashkirja.db'
```

Open the snapshot on its own and confirm a known row is present:

```bash
sqlite3 data/backups/lashkirja-YYYY-MM-DD-HHMMSS/lashkirja.db "PRAGMA integrity_check;"
```

A restore is the snapshot database plus its `uploads/` directory, put back as `data/lashkirja.db` and `data/uploads/`. Do not restore a `-wal` file next to this snapshot. The snapshot is already consistent.

Prove a snapshot before you need it:

```bash
bash scripts/restore-drill.sh data/backups/lashkirja-YYYY-MM-DD-HHMMSS
```

The script copies the snapshot into a fresh temporary directory, runs `PRAGMA integrity_check`, and checks the manifest hash and upload count. `LASHKIRJA_RESTORE_SQL` can require a known row. `LASHKIRJA_RESTORE_CLEAN=1` deletes the temporary copy after a successful check. See `app/docs/deploy-rollback.md` for when to point `DATABASE_URL` at that copy.
