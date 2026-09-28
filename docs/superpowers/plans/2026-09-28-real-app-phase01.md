# Real App Phase 0+1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run LashKirja as a stable production instance on the owner's Windows PC behind a fixed Tailscale Funnel URL, make the iOS shell impossible to lock up (logout, revoked session, unreachable server), and ship a new unsigned IPA that points at the fixed URL.

**Architecture:** The repo work covers the logout and session fixes, a self-healing offline page, the native name and Info.plist, and Windows ops scripts. It lands on branch `feat/real-app-phase01`, stacked on `feat/ux-phase2-design`. A separate production checkout at `C:\LashKirja\prod` runs `next start` and the worker under a supervisor started by a per-user Scheduled Task. It has its own `.env`, `prod.db` and `uploads/`. Tailscale Funnel on port 8443 forwards to it.

**Tech Stack:** Next.js 16 (read `app/node_modules/next/dist/docs/` first), React 19, Prisma 7 + SQLite (libsql), iron-session, Capacitor 8 iOS, PowerShell 5.1, Tailscale.

**Spec:** `docs/superpowers/specs/2026-09-28-real-app-roadmap.md` (Faz 0 and Faz 1). The evidence with file:line references is in `docs/superpowers/research/2026-09-28-real-app-findings.md` §3 (logout) and §2.3.

## Global Constraints

- Fixed public URL: `https://desktop-7gu8ukj.tail42feb1.ts.net:8443`. Production listens on `127.0.0.1:3300`.
- NEVER touch the existing Tailscale serve entries: port 443 → 8766, `/wa-proxy`, and 8446-8452. They are the owner's other projects. Only add `--https=8443`.
- The dev checkout `C:\Users\Hhusey\lashkirja` and its dev server on :3200 stay as they are. Do not stop the dev server.
- The production data (`prod.db`, `uploads/`) never mixes with the demo DB. The production DB starts fresh from migrations.
- Secrets: the production `.env` is created by copying the dev `.env` and then overriding the URL, cookie and DB values. It is never committed and never printed to logs or reports. Report key NAMES only.
- Native app name: "LashKirja". The bundle id `fi.tiyouba.lashkirja` stays unchanged.
- Baselines:
  - unit tests: 5 Windows-only failures (backup-script 3, db-permissions 1, db-upgrade 1);
  - lint: 11 errors / 28 warnings.
  - Integration tests on Windows need the shim: `NODE_OPTIONS="--require C:/Users/Hhusey/AppData/Local/Temp/claude/C--Users-Hhusey/26fedb5a-984d-4af0-ad71-2539bf3779d3/scratchpad/finalfix/npx-shell-shim.js"`. Never commit it.
- Every commit ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Dt441ofXM5z9eZZdckoQC9
  ```
- Edit with file tools. No git worktrees or junctions.

---

### Task 1: Logout and session robustness (web)

**Files:** `app/src/components/clientFetch.ts`, `app/src/proxy.ts`, `app/src/lib/session*.ts` (wherever revocation is stored; find it), `app/src/app/api/auth/logout/route.ts`, `app/src/components/AppShell.tsx` (only the logout call site), and the tests next to them.

- [ ] **Revoked-session loop.** A cookie whose session was revoked (after a logout elsewhere or a password reset) currently makes `/login` ↔ `/dashboard` redirect forever (research §3, `proxy.ts:46-60`).
  - The proxy must treat a revoked or invalid session as signed out, delete the session cookie on the response, and let `/login` render.
  - If revocation needs a DB lookup, the proxy must stay cheap. Check how revocation is stored (e.g. a session version on the user). Where the proxy cannot see revocation, the `/login` page and `/` must not redirect a cookie that `/api/auth/me` rejects.
  - Write an integration test that reproduces the loop, fails before the fix and passes after.
- [ ] **401 handling.** Any API 401 clears the cookie server-side (the response deletes it) and `redirectToLogin()` runs once. Guard against redirect storms: one redirect per page lifetime.
- [ ] **Logout.** In `leaveAfterSignOut`:
  - navigate exactly once;
  - add a fallback: if the page is still there 3 s after `location.replace("/login")`, remove `signing-out` and call `location.assign("/login")`;
  - if the server logout fails, still clear the cookie client-visible state and show an error inside the profile sheet. Never leave the body faded.
  
  Add unit tests for the fallback using fake timers.
- [ ] Verify: typecheck, lint, unit tests, and the new integration tests (with the shim). Then a Playwright check on :3200: log in → log out → the login page renders. Revoke the session (use the app's own revoke path or a test helper; never change the demo user's password) → reload → the login page renders, with no loop (count navigations: ≤ 2).
- [ ] Commit `fix(auth): no redirect loop on revoked sessions, logout never strands the page`.

### Task 2: Self-healing offline page, name and Info.plist (native)

**Files:** `app/public/offline.html`, `app/capacitor.config.ts`, `app/scripts/patch-ios-url-scheme.ts` (or a new `app/scripts/patch-ios-plist.ts` run from the same workflow step), `app/ios/App/App/Info.plist` (committed values only), `.github/workflows/build-ipa.yml`.

- [ ] **`offline.html`.** Capacitor 8.5 shows this page on ANY failed navigation, including a cancelled one (`WebViewDelegationHandler.swift:149-153`). Its retry currently reloads only itself. Make it self-healing:
  - know the server URL (bake it in at `cap sync` time: the patch script writes a `<meta name="lashkirja-server" content="…">` into the synced copy under `ios/App/App/public/offline.html`, or reads `window.Capacitor` config if that is available; pick the one that works and explain why);
  - retry automatically: immediately once, then after 2 s, 5 s, 10 s, then every 15 s while visible; each retry does `location.replace(serverUrl + "/dashboard")`;
  - the "Yritä uudelleen" button navigates to the server URL, not `location.reload()`;
  - the copy explains in Finnish that the server could not be reached and it retries automatically. Keep the page's current look (tokens already match). No em dashes.
- [ ] **Name.** `appName` becomes "LashKirja", and `CFBundleDisplayName` becomes "LashKirja" (patched after sync if Info.plist is generated). The IPA file name in the workflow becomes `LashKirja-unsigned.ipa`, and so does the artifact name.
- [ ] **Info.plist.**
  - Remove `armv7` from `UIRequiredDeviceCapabilities` (use `arm64` or remove the key).
  - Set `CFBundleDevelopmentRegion` to `fi`.
  - Add `ITSAppUsesNonExemptEncryption` = false.
  - Ensure Finnish `NSCameraUsageDescription` and `NSPhotoLibraryUsageDescription` strings exist ("LashKirja käyttää kameraa kuittien kuvaamiseen." / "LashKirja lukee kuvia kuittien lisäämiseksi.").
  - Follow how the repo already manages Info.plist: committed file or patch script.
- [ ] Verify: typecheck and lint. Serve `offline.html` locally via Playwright with a fake server URL and confirm the retry schedule and button target. Grep that no "Tilikirja" remains in user-visible native config.
- [ ] Commit `fix(ios): offline page heals itself, LashKirja name, Info.plist cleanup`.

### Task 3: Windows production instance and ops scripts

**Files (repo):** `app/scripts/ops/deploy-local.ps1`, `app/scripts/ops/run-prod.ps1` (the supervisor), `app/scripts/ops/backup-local.ps1`, `app/scripts/ops/install-tasks.ps1`, `app/docs/ops-windows.md`.

**Outside the repo:** `C:\LashKirja\prod` (git clone of `origin`, checked out at `feat/real-app-phase01`), `C:\LashKirja\data\prod.db`, `C:\LashKirja\data\uploads\`, `C:\LashKirja\backups\`, `C:\LashKirja\logs\`.

- [ ] **`deploy-local.ps1`**, run from anywhere. In order:
  1. `git fetch` and check out the given branch or ref in `C:\LashKirja\prod`;
  2. `npm ci --prefer-offline`;
  3. `npx prisma generate`;
  4. back up the DB (call `backup-local.ps1`);
  5. `npx prisma migrate deploy` against `prod.db`;
  6. `npm run build` into a new build directory, and swap it in only on success (keep the previous `.next` as `.next.prev` for rollback);
  7. restart the supervisor;
  8. poll `http://127.0.0.1:3300/api/health` for up to 60 s, and on failure roll back to `.next.prev` and restart.
  
  It logs to `C:\LashKirja\logs\deploy-<timestamp>.log`.
- [ ] **`run-prod.ps1`.** A supervisor loop that keeps both `next start -p 3300 -H 127.0.0.1` and `npm run worker` alive. On a crash it restarts with backoff (1, 5, 30 s, capped). Logs rotate daily under `C:\LashKirja\logs\`. A PID file allows a clean stop (`run-prod.ps1 -Stop`).
- [ ] **`backup-local.ps1`.**
  - It uses a consistent SQLite backup: the libsql or Prisma client `VACUUM INTO`, or the sqlite3 CLI if present. Do not copy the file while it is being written.
  - It copies `uploads/` and zips both to `C:\LashKirja\backups\lashkirja-<date>.zip`. It keeps 30 daily copies and 12 monthly copies (the first of the month is kept 10 years for kirjanpitolaki).
  - If a OneDrive folder exists (`$env:OneDrive`), it mirrors the zip to `$env:OneDrive\LashKirja-backups\`.
  - It includes a `-RestoreTest` switch that restores the latest zip into a temp dir and runs an integrity check (`PRAGMA integrity_check`) plus a row count on the users table.
- [ ] **`install-tasks.ps1`.** It registers per-user Scheduled Tasks (no admin needed):
  - "LashKirja prod" runs `run-prod.ps1` at logon;
  - "LashKirja backup" runs `backup-local.ps1` daily at 03:00.
  
  It also disables sleep on AC via `powercfg /change standby-timeout-ac 0` (report if that needs admin and skip gracefully). It is idempotent.
- [ ] **The production `.env`.** Copy it from the dev `.env`, then set:
  - `DATABASE_URL` to `C:\LashKirja\data\prod.db`;
  - the uploads directory variable (find its name) to `C:\LashKirja\data\uploads`;
  - `NODE_ENV=production`;
  - `COOKIE_SECURE=true`;
  - the app base URL variables (find their names, e.g. `APP_URL` / `NEXT_PUBLIC_APP_URL` / `SESSION_*`) to the fixed URL;
  - a NEW session secret (generate it; do not reuse dev's).
  
  Report changed key names only. Enable Banking's redirect URL must be registered by the owner in their Enable Banking dashboard: write the exact URL in the report.
- [ ] **The owner's account in `prod.db`.** Use the app's own account-creation path: the sign-up/registration flow via the fixed URL, or an existing script; look in `app/scripts/` and `app/docs/ops.md`. The email is `harunhusey556@gmail.com`. If the path requires a password, generate a strong temporary one, write it ONLY to `C:\LashKirja\OWNER-FIRST-LOGIN.txt`, and tell the owner to change it on first login. Never put it in the report or a commit.
- [ ] **Tailscale Funnel.** Run `tailscale funnel --bg --https=8443 http://127.0.0.1:3300`. Verify with `tailscale funnel status` that the old entries are unchanged and 8443 shows "Funnel on".
- [ ] **Verify:**
  - Run `deploy-local.ps1` end to end.
  - Reboot-equivalent test: stop the supervisor, run the Scheduled Task manually, and health is back.
  - Playwright through the fixed URL, as the owner account: log in, then open Koti, Myynti, Kirjanpito, Raportit and Asetukset (each has an h1), then log out and see the login page. Also check the revoked-session case.
  - Measure throttled 4G (see the research script `scratchpad/perf-measure.js`): full load and tab switch.
  - `backup-local.ps1 -RestoreTest` passes.
- [ ] Commit the scripts and the docs: `feat(ops): local production instance on Windows with backups and Tailscale Funnel`.

### Task 4: New IPA pointed at the fixed URL

- [ ] Push `feat/real-app-phase01`, then run `build-ipa.yml` on it with `capacitor_server_url=https://desktop-7gu8ukj.tail42feb1.ts.net:8443`.
- [ ] Download the artifact and verify inside the IPA:
  - `capacitor.config.json` has the fixed URL;
  - `CFBundleDisplayName` is LashKirja;
  - the offline page carries the server URL.
- [ ] Hand the IPA to the controller.
