# WORKER REPORT — fix/account-mail-hardening (B1–B3 + should-fix items from logs/review-account-mail.md)

Base: `integrate/account-mail` (c830c9a). The migration `20261012090000_account_mail` is not yet
deployed, so it was extended in place. It stays purely additive: one CREATE INDEX, one CREATE TABLE,
one CREATE UNIQUE INDEX. No push or merge.

## Files
- `app/prisma/schema.prisma` and `.../20261012090000_account_mail/migration.sql`
  - `PendingSignup @@index([expiresAt])`.
  - New `AccountCodeGuard { scope @unique, hourFailures, hourStart, dayFailures, dayStart, blockedUntil }`.
    The brief's single `failures/windowStart` cannot hold both the 1 h and the 24 h windows, so
    there are two counters. The SQL is copied from `prisma migrate diff`.
- `app/src/lib/account-code-guard.ts` (new)
  - B2: `reserveCodeAttempt(scope)` counts the guess before the compare, using atomic conditional
    `updateMany`. Rule: 5 within 1 h blocks for 1 h. 10 within 24 h blocks for 24 h.
  - `clearCodeGuard` runs on success. `pruneStaleCodeGuards` runs in the cleanup.
- `app/src/lib/signup.ts`
  - B1: `verifySignup(email, code, password)` checks the bcrypt password against the pending row.
    The code and the password are both checked every time. A mismatch costs one attempt and answers
    `400 SIGNUP_CODE_INVALID`, like a wrong code.
  - B2: the guard `signup:<email>` is checked after the row lookup. While blocked, verify answers
    like a wrong code with `attemptsLeft: 0` and compares nothing.
  - `pruneExpiredPendingSignups()` added.
- `app/src/lib/account-security.ts`
  - Step 5: `hashEmailCode` is now HMAC-SHA-256. The pepper is HMAC(SESSION_SECRET, fixed label), and
    the scope stays in the message.
  - B3: both reset paths finish in one `completeReset` transaction: conditional consume (id,
    purpose, `usedAt: null`, `expiresAt > now`, count must be 1), then the password, then session
    revocation through `revokeSessionsWithin`. `revokeAuthSessions` uses the same writes.
  - Reset-by-code: a missing user, no reset, an expired reset, a blocked target and a wrong code all
    answer `400 { error: "Koodi ei kelpaa tai se on vanhentunut.", code: "RESET_CODE_INVALID" }`.
    `RESET_EXPIRED` and `attemptsLeft` are gone from this path. Guard scope: `reset:<userId>`.
  - `deliverInBackground` / `settleAccountMailForTests`. Security notices are fire-and-forget,
    including the user lookup. `notify*` now return `void`.
  - `accountLinkBase` returns `null` when `NODE_ENV=production` and `APP_ORIGIN` is not set. It logs
    once, and the callers then send no link mail.
- Routes:
  - `signup/verify`: requires `password`. It sends no welcome mail when there is no link base.
  - `signup/resend`: the renewal and the send run in the background.
  - `signup/start`: no "existing account" notice when there is no link base.
  - `password/forgot`: the lookup, the reset row, the mail and the recovery queueing all run in the
    background. With no link base, it queues a recovery request instead.
  - `password/reset`, `password`, `email/confirm`: the notice is not awaited.
  - `email`: the confirm link comes from `accountLinkBase`. With no link base, the change is
    cancelled and the route answers 409, the existing failure path.
  - `cron/cleanup`: also prunes expired `PendingSignup` rows and stale guards. `scripts/worker.ts`
    has no cleanup path, so the prune runs from the cron cleanup route that
    `scripts/ops/run-cron.ps1` calls.
- iOS:
  - `SignUpVerifyBody` gains `password`.
  - `AuthService.signupVerify(email:code:password:)`.
  - `SignUpView` passes the password it already holds.
  - New `AccountCodeFailure.resetCodeInvalid`, with the message "Koodi ei kelpaa tai se on vanhentunut."
  - `AccountCodeTests` are updated. LashKirjaCore still imports only Foundation.
  - **Not compiled here** (no Swift toolchain on this machine); CI compiles it.
- Tests:
  - `app/tests/integration/account-mail.test.ts`: 12 new tests and 6 adapted.
  - `review-remainder.test.ts` and `wave-i-account.test.ts` now wait for background mail.
- `logs/account-mail-contract.md`: sections 1–3 are updated. The file is untracked (`logs/`), so it
  is not in the commit.

## Tests first
These 15 tests were red before the implementation (after adding only the schema and the test helper):
- B1: the victim's verify with the newest code returned 200 and created the account with the
  attacker's password.
- B2: both sign-up tests and the reset test.
- B3: the two concurrent link resets returned `[200, 200]`.
- Enumeration, HMAC, cleanup, the production origin check, three tests that answer before the mail
  is sent, and the notice lookup test.
- Existing tests whose contract changed: the 410 answers and `attemptsLeft` in reset-by-code.

## Checks (run in this worktree, foreground)
- `npm ci && npx prisma generate`: ok (Prisma Client 7.9.1)
- `npx tsc --noEmit -p .`: exit 0, no output
- `npm run lint`: 0 errors, 30 warnings, none in the touched files
- `account-mail.test.ts`: 18/18 passed before the change, 30/30 after
- Integration suite: 98 files, **1030/1030 passed** (1018 before, plus 12 new), 4m13s
- `npx vitest run src`: 1711 passed, 6 failed out of 1717.
  - 5 of the 6 are the known Windows-only failures: backup-script ×3, db-permissions ×1, and
    db-upgrade ×1 (`spawnSync ...\.bin\prisma ENOENT`).
  - glossary-lint timed out under load. Rerun alone, it passed 3/3.
- `prisma migrate diff` (migrations → schema) shows no AccountCodeGuard or PendingSignup drift.
  The SalesInvoice redefine it prints is already present on the base schema.

## Not done / residual
- Not compiled: the iOS changes (see above).
- Not measured: response timing of forgot and resend. The tests only prove that the response does
  not wait for SMTP. Reset-by-code still does a different number of DB reads for a missing user and
  for an existing one (milliseconds; the status and body are identical).
- Unchanged from the review, not in this brief:
  - signup verify still answers 410 vs 400, which shows whether a pending row exists.
  - `signup/start` still awaits SMTP.
  - Rate limits are process-local (the durable guard now caps code guesses).
  - The body limit trusts `Content-Length`.
  - Concurrent forgot requests can leave two active reset rows.
- Background mail is a plain unawaited promise, without `after()`. This is enough for the
  self-hosted `next start`. A serverless host would need `after()`.
