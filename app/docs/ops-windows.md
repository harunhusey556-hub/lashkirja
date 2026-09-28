# Production on the Windows PC

LashKirja's production instance runs on the owner's Windows PC, separate from the dev checkout. The public address is fixed:

**https://desktop-7gu8ukj.tail42feb1.ts.net:8443**

Tailscale Funnel terminates HTTPS on port 8443 and forwards to `http://127.0.0.1:3300`. Nothing else listens publicly. The general health, logging and reliability notes are in `app/docs/ops.md`. Linux-style backups are in `app/docs/backup.md`. This page covers the Windows instance.

## What runs where

| Piece | Location |
| --- | --- |
| Production checkout (plain `git clone`, not a worktree) | `C:\LashKirja\prod` (the app is in `prod\app`) |
| Production settings | `C:\LashKirja\prod\app\.env` (git-ignored, never committed) |
| Database | `C:\LashKirja\data\prod.db` (SQLite, WAL) |
| Uploads (receipts, statements, PDFs) | `C:\LashKirja\data\uploads\` |
| Data-copy packages (Tietosuoja) | `C:\LashKirja\data\account-packages\` |
| Backups | `C:\LashKirja\backups\lashkirja-YYYY-MM-DD.zip`, mirrored to `%OneDrive%\LashKirja-backups\` |
| Logs | `C:\LashKirja\logs\` (`web-`, `worker-`, `supervisor-`, `backup-` per day; `deploy-<timestamp>.log`) |
| Supervisor state | `C:\LashKirja\run\supervisor.pid` |
| Web server | `next start` on `127.0.0.1:3300` (loopback only) |
| Background worker | `scripts/worker.ts` (mail sync, bank sync, document jobs, every 10 min) |
| Dev server (untouched) | `C:\Users\Hhusey\lashkirja`, `next dev` on :3200, demo database |

The app keeps its files under `process.cwd()\data`. There is no separate uploads variable. The supervisor starts both processes with the working directory `C:\LashKirja`, so `data\` resolves to `C:\LashKirja\data` and never to the git checkout. `DATABASE_URL` is absolute as well.

`C:\LashKirja` is readable only by the owner's account, SYSTEM and Administrators. Inheritance is removed at the top folder.

## Scripts

All four are in `app/scripts/ops/`. Run them with `powershell -NoProfile -ExecutionPolicy Bypass -File <script>`. Use the copies in `C:\LashKirja\prod\app\scripts\ops\` for day-to-day work.

| Script | What it does |
| --- | --- |
| `run-prod.ps1` | Supervisor. Keeps `next start` and the worker alive. A crash restarts after 1 s, then 5 s, then 30 s (the backoff resets after 2 minutes of uptime). `-Stop` stops it cleanly. `-Status` shows the processes and health. |
| `deploy-local.ps1` | Deploys a git ref: fetch, stop, checkout, `npm ci`, `prisma generate`, backup, `prisma migrate deploy`, build, start and a health check. It rolls back on failure. `-Remote` (default `origin`) and `-Ref` (default `feat/real-app-phase01`). |
| `backup-local.ps1` | Takes a consistent backup zip, applies retention and mirrors to OneDrive. `-RestoreTest` proves the newest zip. |
| `install-tasks.ps1` | Registers the two per-user Scheduled Tasks and turns off sleep on AC power. It is idempotent. |

## Start, stop, status

The "LashKirja prod" Scheduled Task starts the supervisor at logon. Control it through the task and the supervisor, never by killing `node`. The dev server's node processes are not yours to kill.

```powershell
$ops = 'C:\LashKirja\prod\app\scripts\ops'
powershell -NoProfile -ExecutionPolicy Bypass -File $ops\run-prod.ps1 -Status   # processes + /api/health
powershell -NoProfile -ExecutionPolicy Bypass -File $ops\run-prod.ps1 -Stop     # stop web + worker
Start-ScheduledTask -TaskName 'LashKirja prod'                                  # start again
```

`-Stop` signals the supervisor through `run\supervisor.stop`, waits up to 30 s, and then kills its process tree. It also stops any leftover node process whose command line points into `C:\LashKirja\prod\app`. That test only matches production processes.

`/api/health` needs `Authorization: Bearer <HEALTH_TOKEN>` in production. `-Status` reads the token from `.env` without printing it.

The tasks run only while the owner is logged on. A locked screen is fine; signing out stops the server. After a reboot the server comes back when the owner logs in. For unattended restarts, turn on automatic sign-in, or re-register the prod task from an elevated prompt with a "run whether user is logged on or not" principal.

## Deploy

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\LashKirja\prod\app\scripts\ops\deploy-local.ps1
# another branch or tag, or GitHub once the branch is pushed:
powershell -NoProfile -ExecutionPolicy Bypass -File C:\LashKirja\prod\app\scripts\ops\deploy-local.ps1 -Remote github -Ref main
```

`origin` in the production checkout is the local dev repository (`C:\Users\Hhusey\lashkirja`). Commit there, then deploy. `github` is `https://github.com/harunhusey556-hub/lashkirja.git`.

The order is:

1. fetch;
2. stop;
3. checkout;
4. `npm ci --prefer-offline`;
5. `prisma generate`;
6. `backup-local.ps1 -Tag predeploy`;
7. `prisma migrate deploy`;
8. the previous `.next` becomes `.next.prev`, then `next build`;
9. start through the task;
10. poll `/api/health` for 60 s.

The log is `C:\LashKirja\logs\deploy-<timestamp>.log`.

The app is down during a deploy: 1.5 minutes measured on an idle PC, about 6 minutes while the PC was busy. On Windows, `npm ci` cannot replace native `.node` modules that a running server has loaded. `next build` always writes the `.next` directory that `next start` serves, because `distDir` is fixed in `next.config.ts`. So the build cannot run beside the live server. The previous build is kept as `.next.prev` for rollback.

Failure handling:

- **install, generate, backup or build fails:** the previous commit, its `node_modules` and `.next.prev` are put back, and the old version is started again.
- **health check fails after start:** `.next.prev` is swapped back and started against the same (already migrated) database. The migrations in this repo are additive; see `app/docs/deploy-rollback.md`.
- **`prisma migrate deploy` fails:** the app stays stopped. Do not serve a database a failed migration touched. Restore the `-predeploy` zip (below), then start the previous build.

Manual rollback to the previous build:

```powershell
$app = 'C:\LashKirja\prod\app'
powershell -NoProfile -ExecutionPolicy Bypass -File $app\scripts\ops\run-prod.ps1 -Stop
Remove-Item $app\.next -Recurse -Force; Rename-Item $app\.next.prev .next
Start-ScheduledTask -TaskName 'LashKirja prod'
```

## Backups

The "LashKirja backup" task runs `backup-local.ps1` daily at 03:00. If the PC was off at that time, the task runs as soon as it can. A backup:

1. takes a SQLite snapshot with `VACUUM INTO` through the app's own `@libsql/client`. It is consistent while the app runs; the live file is never copied. The snapshot must pass `PRAGMA integrity_check`. The `sqlite3` CLI is not needed;
2. copies `data\uploads` after the snapshot, so every upload the snapshot references is included;
3. writes `MANIFEST.txt`. It contains the database sha256, the user count, the upload count, and one sha256 per upload;
4. zips it to `C:\LashKirja\backups\lashkirja-YYYY-MM-DD.zip`. A second run on the same day adds `-HHmmss`, and a deploy adds `-HHmmss-predeploy`;
5. applies retention: every zip from the 30 most recent backup days, plus the first zip of every month for 10 years (kirjanpitolaki). The monthly rule keeps more than 12 monthly copies;
6. mirrors the zip to `%OneDrive%\LashKirja-backups\` with the same retention, when OneDrive exists.

The zip holds bookkeeping data. It goes to the owner's own OneDrive.

**The `.env` is not in the zip.** `SESSION_SECRET` signs the login cookies, and it is also the key that encrypts stored mailbox passwords and bank secrets (`src/lib/encryption.ts`). Keep a copy of `C:\LashKirja\prod\app\.env` in a password manager. A restore onto a new PC needs the same `SESSION_SECRET`, or the stored mailbox and bank connections must be set up again. Never rotate it casually.

Prove the newest zip:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\LashKirja\prod\app\scripts\ops\backup-local.ps1 -RestoreTest
```

It extracts to a temp folder and checks the database hash and every upload hash against `MANIFEST.txt`. It runs `PRAGMA integrity_check`, counts `User` rows, and then deletes the temp folder. A non-zero exit means the zip is not usable.

## Restore

```powershell
$ops = 'C:\LashKirja\prod\app\scripts\ops'
powershell -NoProfile -ExecutionPolicy Bypass -File $ops\run-prod.ps1 -Stop
$stamp = Get-Date -Format yyyyMMdd-HHmmss
# keep the current state aside, never delete it
New-Item -ItemType Directory C:\LashKirja\data-before-restore-$stamp | Out-Null
Move-Item C:\LashKirja\data\* C:\LashKirja\data-before-restore-$stamp\
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::ExtractToDirectory('C:\LashKirja\backups\lashkirja-YYYY-MM-DD.zip', 'C:\LashKirja\data')
Remove-Item C:\LashKirja\data\MANIFEST.txt
Start-ScheduledTask -TaskName 'LashKirja prod'
powershell -NoProfile -ExecutionPolicy Bypass -File $ops\run-prod.ps1 -Status
```

The zip holds `prod.db` and `uploads\`, so it extracts straight into `data\`. Do not put a `prod.db-wal` or `prod.db-shm` from elsewhere next to the restored file; the snapshot is complete on its own. On a new PC, set up the checkout and the `.env` (with the saved `SESSION_SECRET`) first.

## First-time setup (already done on this PC)

1. Create `C:\LashKirja\{data\uploads,backups,logs,run}` and restrict the folder to the owner.
2. `git clone C:\Users\Hhusey\lashkirja C:\LashKirja\prod`, check out the branch, then `git remote add github https://github.com/harunhusey556-hub/lashkirja.git`.
3. Copy `app\.env` from dev to `C:\LashKirja\prod\app\.env` and override these keys:
   - `DATABASE_URL=file:C:/LashKirja/data/prod.db`
   - `NODE_ENV=production`
   - `COOKIE_SECURE=true`
   - `APP_ORIGIN=https://desktop-7gu8ukj.tail42feb1.ts.net:8443`
   - `TRUST_PROXY=true`
   - `ENABLEBANKING_REDIRECT_URL=https://desktop-7gu8ukj.tail42feb1.ts.net:8443/bank/callback`
   - new random `SESSION_SECRET`, `CRON_SECRET` and `HEALTH_TOKEN` (never the dev values)
4. Run `deploy-local.ps1` from the dev checkout's `app\scripts\ops` (the first time only, before prod has the scripts).
5. Run `install-tasks.ps1` from `C:\LashKirja\prod\app\scripts\ops`.
6. `tailscale funnel --bg --https=8443 http://127.0.0.1:3300`. This adds a port and leaves the other serve entries alone. Never run `tailscale serve reset` or `tailscale funnel reset`; the other ports belong to other projects.
7. Create the owner account. The app has no sign-up page, so this is a one-off Prisma `user.create` with the app's bcrypt cost. The temporary password goes only to `C:\LashKirja\OWNER-FIRST-LOGIN.txt`.

## Tailscale Funnel

```powershell
tailscale funnel status          # 8443 must say "Funnel on"
tailscale funnel --https=8443 off   # take the app off the internet (only this port)
tailscale funnel --bg --https=8443 http://127.0.0.1:3300   # put it back
```

Funnel needs the Tailscale service running and the owner's tailnet to allow Funnel for this node.

Latency: a device **without** Tailscale reaches the app through a public Funnel relay (Frankfurt), which then reaches this PC. That hop is the slow part. Measured on 2026-09-28 while the PC was 90-100% busy: 1.5 to 2.7 s for the TLS handshake and 0.2 to 0.9 s per request. When the PC was less busy, a whole request took 0.7 to 1.0 s. A device **with** the Tailscale app switched on resolves the same URL straight to this PC over the tailnet: about 0.02 to 0.05 s to connect and a median 1.1 s throttled page load. Same URL, same cookie, no configuration change. A busy PC slows both paths, because the TLS for Funnel terminates in `tailscaled` on this machine.

## Enable Banking

The redirect URL registered in the Enable Banking control panel must match `ENABLEBANKING_REDIRECT_URL` character for character:

```
https://desktop-7gu8ukj.tail42feb1.ts.net:8443/bank/callback
```

`ENABLEBANKING_ENABLED` stays `false` until the app id and private key are set in the production `.env`. Use an absolute `ENABLEBANKING_KEY_FILE` path, because the working directory is `C:\LashKirja`. Restart through the supervisor afterwards.

## Native tools

Receipt OCR and PDF text extraction call `tesseract`, `pdftotext` and `pdftoppm` on `PATH` (`src/lib/ai.ts`, `src/lib/parsers.ts`). None of them is on this PC's `PATH` today. Without them:

- **photo receipts** (JPG, PNG, HEIC) are not read by the local OCR (`tesseract`). The fields stay empty for manual entry. The cloud AI (`LLM_API_KEY` with `CLOUD_AI_ENABLED`) reads images when it is configured;
- **scanned PDFs** (no text layer) are not rasterised and OCR'd (`pdftoppm` + `tesseract`);
- **text PDFs** still work. `pdftotext` falls back to the bundled `pdf-parse`. Bank statement parsing loses the `-layout` text and uses the plain text, so column-heavy statements may parse less well. To add the tools, install Tesseract (with the `fin` and `swe` language data) and Poppler for Windows. Add both `bin` folders to the user `PATH`, then restart the supervisor.

## Logs

- `web-YYYY-MM-DD.log` and `worker-YYYY-MM-DD.log` hold the process output.
- `supervisor-YYYY-MM-DD.log` holds starts, exits, restarts and backoff.
- `backup-YYYY-MM-DD.log` and `deploy-<timestamp>.log`.

The supervisor deletes logs older than 30 days. Logs never contain `.env` values. The supervisor logs key names only.
