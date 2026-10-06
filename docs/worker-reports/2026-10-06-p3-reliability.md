# P3 Reliability and offline behavior (2026-10-06)

Branch `feature/p3-reliability` from `origin/native` (4c3e6ec).

## Audit: what already held
- 401 ends the session once, only for the request that carried the current token (`APIClient`); no refresh-and-retry loop exists because the 30-day token refreshes on launch, not on 401. Now pinned by tests.
- Logout and session expiry run `endLocalSession` (chat, document cache, profile, notifications, pending routes) before the sign-in screen shows.
- GET gateway retry (502/503/504, three tries, backoff) and "POST never retried" existed.
- Most keyed POSTs already use `SubmitGuard` or a per-sheet key.

## Gaps found and fixed
Client (`ios-native/LashKirjaCore`, tests first in `ReliabilityTests.swift`):
- `RetryPolicy`: retry rules extracted from `APIClient`; a GET now also retries once-per-attempt on a dropped connection (`networkConnectionLost`), never offline or timeout, never a write.
- `ReachabilityState`: pure state for the one indicator. No network path gives "Ei verkkoyhteyttä"; two consecutive requests that got no answer (path fine, tunnel or server down) give "Palvelimeen ei saada yhteyttä"; any app answer clears it. `APIClient.setOnReachability` feeds it; cancelled requests say nothing.
- `WriteFailureCopy`: Finnish copy that says what was or was not saved and what to do (offline: nothing sent; lost answer: may have gone through, check before retrying, same attempt will not double).

App (`ios-native/App/Sources`):
- `Connectivity` uses `ReachabilityState`, keeps `online` (path only) for the receipt queue, and while the server is unreachable probes `/api/auth/me` every 8 s so the banner clears by itself.
- Invoice copy and payment reminder send now send an `Idempotency-Key` that is reused on retry (`SubmitGuard`) and use `WriteFailureCopy`.
- Purchase suggestion "Hyväksy" used a fresh key per tap; now one key per suggestion.

Server (`app/`):
- `POST /api/invoices/[id]/duplicate` and `POST /api/invoices/[id]/reminders` use `withIdempotentSideEffect` (same mechanism as invoice send), scopes `invoice-duplicate:<id>` and `invoice-reminder:<id>`. Without a key behaviour is unchanged (reminder cooldown still refuses repeats). A failed run releases the key. The same key with a different reminder body gets 409.
- No schema change (reuses `IdempotencyRecord`).
- Tests: `app/tests/integration/invoice-copy-reminder-idempotency.test.ts` (8 tests) plus `reminders.test.ts` still green.

## Not done
- The dropped-connection GET retry and probe are unverified on a device; Swift was not built locally (CI only).
- Receipt capture queue and POS flows untouched.
- Money math, OTP, Tap to Pay, passkey code untouched.

## Simulator checks
Kill the API tunnel with a screen open: after two failed loads the banner reads "Palvelimeen ei saada yhteyttä"; restore it and the banner clears within about 8 s. Airplane mode shows "Ei verkkoyhteyttä". Tap "Kopioi" or send a reminder while the tunnel is down: the message says it may have gone through, and the retry does not duplicate.
