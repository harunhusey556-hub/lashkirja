# WORKER-REPORT — account mail, server side

Branch `feature/account-mail-server`, base `f1be13f`. Implementation commit `06b0842`.
Not pushed, not merged. Contract sections 1, 2 and 3 implemented; section 4 still passes (see tests).

## Files changed (14)

| File | Change |
|---|---|
| `app/prisma/schema.prisma` | new `PendingSignup` model; `AccountToken.codeHash String?`, `AccountToken.codeAttempts Int @default(0)` |
| `app/prisma/migrations/20261012090000_account_mail/migration.sql` | additive migration (below) |
| `app/src/lib/signup.ts` | new: flag, guards, pending sign-up start/renew/verify, mail texts |
| `app/src/lib/account-security.ts` | `AccountSecurityError` gets optional `code`/`attemptsLeft` + `body()`; `newEmailCode`, `hashEmailCode`, exported `hashesEqual`, `MAX_CODE_ATTEMPTS`; `issuePasswordResetWithCode` (`issuePasswordReset` still returns the token); `resetPasswordWithToken` now returns the userId; new `resetPasswordWithCode`; `confirmEmailChange` also returns `previousEmail`; `accountLinkBase`, `helsinkiTime`, `maskEmail`, `notifyPasswordChanged`, `notifyEmailChanged` |
| `app/src/app/api/auth/signup/start/route.ts` | new |
| `app/src/app/api/auth/signup/verify/route.ts` | new |
| `app/src/app/api/auth/signup/resend/route.ts` | new |
| `app/src/app/api/auth/signup/status/route.ts` | new (GET, `Cache-Control: no-store`) |
| `app/src/app/api/auth/password/forgot/route.ts` | the mail adds the 6-digit code under the link |
| `app/src/app/api/auth/password/reset/route.ts` | accepts `{token,password}` (unchanged) or `{email,code,password}`; sends a notice |
| `app/src/app/api/auth/password/route.ts` | sends a notice after a change |
| `app/src/app/api/auth/email/confirm/route.ts` | sends a notice to the old address after a confirmed change |
| `app/.env.example` | platform mail block (`PLATFORM_SMTP_*` names, no values) + `SIGNUP_ENABLED="false"` |
| `app/tests/integration/account-mail.test.ts` | new, 18 tests |

## Migration SQL (`20261012090000_account_mail/migration.sql`)

```sql
ALTER TABLE "AccountToken" ADD COLUMN "codeHash" TEXT;
ALTER TABLE "AccountToken" ADD COLUMN "codeAttempts" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE "PendingSignup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "PendingSignup_email_key" ON "PendingSignup"("email");
```
No DROP, RENAME or table rebuild. The brief's folder pattern `2026101209000_*` has 13 digits. Every
other migration has 14, so I named the folder `20261012090000_account_mail`. It still sorts after
`20261011090000_pos_refund_corrections`.

## Test commands and real results (Windows, 2026-10-03)

| Command (in `app/`) | Result |
|---|---|
| Red run before the implementation: `npx vitest run --config vitest.integration.config.ts tests/integration/account-mail.test.ts` | 1 file failed, 0 tests ran (the signup route modules did not exist yet, so the import failed) |
| Same command after the implementation | 18 passed / 0 failed |
| `npx tsc --noEmit -p .` | exit 0, no output |
| `npx eslint . --max-warnings=0` | exit 1: 0 errors, 30 warnings, all in files this change does not touch (e.g. `mail-sync.ts`, `sales-invoices.ts`, older tests) |
| `npx eslint --max-warnings=0` on every changed source and test file | exit 0 |
| `npm run lint` (repo script) | exit 0 (30 warnings, 0 errors) |
| Full integration suite, run in the foreground in 2 batches (files 1–40, then 41–98) because one run can last at most 10 min | 40 files / 410 tests passed; 58 files / 601 tests passed. **Total 98 files, 1011 passed, 0 failed** |
| `npx vitest run src` | 193 files: 189 passed, 4 failed. Tests: 1711 passed, 6 failed |

The 6 unit failures:
- `backup-script.test.ts` (3), `db-permissions.test.ts` (1), `db-upgrade.test.ts` (1): known on
  Windows (they need the `sqlite3` CLI). I did not try to fix them.
- `glossary-lint.test.ts` (1): **5000 ms timeout** during the full parallel run, not a retired-word
  hit. Run alone (`npx vitest run src/lib/glossary-lint.test.ts`): 3 passed, 0 failed, 2.4 s. I did
  not run this test on the base commit, so I can't say whether it also timed out before this change.

A fix during verification: on the first full run, 2 tests in `passkey.test.ts` failed with
`Invariant: AsyncLocalStorage accessed in runtime where it is not available`. That file imports
`next/experimental/testing/server`, which patches every `console.*` method with a hook that only
works inside Next's runtime. My notice code called `console.error` when no mail path existed. I
removed that log (and the matching "welcome not sent" log). Having no mail path is an expected state,
and `sendAccountMail` already logs real send failures. After the fix, passkey + account-mail +
wave-i-account: 58/58 passed, and the full integration suite above passed.

## Behaviour details the iOS worker may need

- Wrong code: `400 { error: "Koodi ei kelpaa.", code: "SIGNUP_CODE_INVALID" | "RESET_CODE_INVALID", attemptsLeft }`.
  `attemptsLeft` goes 4, 3, 2, 1, 0. The wrong code that brings it to 0 voids the row, and the next
  call gets `410 SIGNUP_EXPIRED` / `RESET_EXPIRED`, even with the correct code.
- An unknown address, an expired code and a voided reset all answer the same body: `410 RESET_EXPIRED`.
- Five wrong reset codes void the whole reset row, so **the mailed link stops working too**. The user
  has to ask for a new reset.
- Start answers `200 { ok: true, mailConfigured: true }` for new and existing addresses alike. When
  platform mail is unset, or the send throws, start answers 503 `{ error: "Tilin luonti ei ole juuri nyt käytössä." }`
  and keeps nothing. Resend also answers 503 when platform mail is unset.
- If resend's mail send throws, the answer stays the neutral 200 (the failure is logged), so it
  doesn't reveal which addresses have a pending sign-up.
- Resend sets a new code, resets attempts to 0 and starts a new 15-minute window. It works on an
  existing pending row even after that row has expired.
- Verify accepts `device: "ios-app"` exactly like `POST /api/auth/token` (session label "iPhone · LashKirja-sovellus").
- The created User has `lastName: ""` and `onboarded: false`. The app's onboarding fills the rest.
- `SIGNUP_ENABLED` turns sign-up on only when it is exactly `true` (case-insensitive, trimmed).
- Notice times use Finnish local time, e.g. `3.10.2026 klo 14.05`. The masked address is `u***@example.com`.
- The email-change notice uses `contactSupportPhrase()`: "ota yhteyttä tukeen", plus the address when `SUPPORT_EMAIL` is set.

Rate limits are in-process memory (`consumeRateLimit`):
- start: 5/h per email, 20/h per IP
- verify: 10/h per email, 10/h per IP
- resend: 1 per 60 s and 5/h per email, 20/h per IP
- reset: the existing 10/h per IP, plus 10/h per email on the code path

## Contract changes

None to paths, field names or status codes. These are additions or choices the contract left open:
- Error bodies for an expired or void code carry `code` (`SIGNUP_EXPIRED` / `RESET_EXPIRED`) as specified.
  `RESET_CODE_INVALID` also carries `attemptsLeft`, which the contract only listed for sign-up.
- Mail subjects not fixed by the contract: notice to an existing address "LashKirja-tilin luonti";
  welcome "Tervetuloa LashKirjaan"; notices "LashKirjan salasana vaihdettiin" and
  "LashKirjan kirjautumissähköposti vaihdettiin".

## Not done / not measured

- No live SMTP send. All mail went through `MAIL_TRANSPORT=json` with a test spy on `sendPlatformMail`.
- `npm run build` was not run (not in the brief's list).
- No test drives the 10/h verify or reset-code limits, or the resend 5/h limit, to exhaustion.
  Covered: start 5/h per email, start 20/h per IP, resend 1/min.
- Rate limits are per process. With several app instances they are per instance, same as the existing auth routes.
- Codes are stored as a scoped SHA-256 hash, not HMAC. Anyone who can read the DB could brute-force
  the 1M possible codes offline, but the same DB access already exposes the account data.
- `.env.example` had no platform mail block, so I added one next to the mail transport block (variable names only).
- Scratch files live in untracked `logs/`: the patch scripts and test logs.
