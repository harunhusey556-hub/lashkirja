# Deploy and rollback

Three pieces move on different clocks. Ship them in this order, and do not point a newer web build at a database that has not migrated.

## Web, IPA, and the database

- **Web.** This Next.js server. An IPA whose `CAPACITOR_SERVER_URL` already points here picks up shell, API, and page changes on refresh. Those changes do not need a new binary.
- **IPA.** A new binary is required when Capacitor plugins, `Info.plist`, the URL scheme, or `scrollEnabled` change. The gaps that still need one are the bank return scheme (`app/docs/bank-return.md`), attaching a PDF from the share sheet and the baked offline page (`app/docs/native-files.md`), and Face ID (`app/docs/app-lock.md`). Playwright in CI is not that smoke.
- **Database.** `npx prisma migrate deploy` before the new web process serves traffic. Migrations on this branch add tables and columns. They do not rename or drop bookkeeping data.

## Compatibility window

One hop:

1. The previous web build can keep running against the database after an additive migration. New columns are ignored by the old process.
2. The new web build must not start until that migration has finished. It reads `AuthSession`, `pendingEmail`, conversations, and job rows.
3. An installed IPA keeps working against the new web while the server URL is unchanged and the native calls it already makes still exist. Removing a plugin the installed IPA calls means shipping the new IPA first, or leaving the old server up until that IPA is updated.

Do not run the new web against an older schema. Do not roll the web back past a migration that already changed a column the old build cannot read. There is no down migration.

## Order

1. `bash scripts/backup-db.sh`
2. `bash scripts/restore-drill.sh data/backups/lashkirja-YYYY-MM-DD-HHMMSS` when you want to prove that snapshot opens. See `app/docs/backup.md`.
3. `npx prisma migrate deploy`
4. Start the new web process.
5. `GET /api/health` with `HEALTH_TOKEN` when it is set. See `app/docs/ops.md`.

## Failed deploy

If `prisma migrate deploy` exits non-zero, do not start the new web. Leave the previous process on the previous schema.

A failed migration is not a reason to delete the database. The upgrade test inserts a user on the previous schema, applies the pending migration, then runs a migration that errors. The user row is still readable, and the failed migration has no `finished_at`. SQLite can keep statements from that file that ran before the error, so do not serve the file the failed deploy touched. Restore the snapshot into a fresh data directory and point `DATABASE_URL` at that file. Do not restore a `-wal` file next to the snapshot.

`prisma migrate resolve` is only for a migration Prisma recorded as failed after a partial apply. Do not mark a migration applied when its SQL did not run.

## Rollback

- **Web only, migration already applied and additive:** start the previous web build against the same database.
- **Migration itself is wrong:** stop the new web, restore the snapshot with `scripts/restore-drill.sh`, and point `DATABASE_URL` at the restored `lashkirja.db` and `uploads/`. Then start the previous web build.
- **IPA:** install the previous IPA only if the server URL it bakes in still serves a build that IPA can call. The web rollback does not replace the binary on the phone.
