# Native crash and error reporting (2026-10-06)

Branch `feature/native-observe`, from `origin/integration`. Swift cannot be built on Windows, so the `iOS native` CI run is the only compile and test check for the Swift side.

## What is sent

`POST /api/observe` with `{ "message": "<=300 chars", "source": "native" }`, bearer token, nothing else. The server redacts again, rate-limits (10/min) and logs it as `kind: client_error`, `route: native`.

- API failure: `api 503 GET /api/invoices/:id app=1.0.0(7) ios=18.2` (`api decode 200 ...` when the answer would not decode).
- MetricKit diagnostic: `crash type=<exception type> code=<exception code> signal=<signal> app=<ver>(<build>) ios=<os> frames=Binary+0xOFFSET,...` (up to 5 innermost frames of the blamed thread; binary name and offset only). Kinds: crash, hang, cpu, disk.

Never sent: amounts, names, emails, tokens, request or response bodies, hosts, query strings, ids (replaced by `:id`).

## Rules

- Only 5xx answers and undecodable answers. Not offline, timeouts, 4xx or cancellations.
- Once per (path template, status) per app session; the key is spent even if the send fails.
- Signed in only (a bearer token exists); otherwise dropped, not queued.
- Detached from the request, one retry after 2 s, then dropped. No UI. Reports to `/api/observe` itself are ignored (no loops).

## Code

- `LashKirjaCore/Observe/Observe.swift`: `ObservePath.template`, `ObservePayload`, `NativeDiagnostic` (+ call stack tree parser), `ObserveReporter` actor (dedupe, signed-in gate, retry). Tests: `ObserveTests.swift`, plus a hook test in `APIClientTests.swift`.
- `APIClient.setOnUnexpectedFailure` (detached hook, called for final 5xx and decode errors).
- `App/Sources/Observe/DiagnosticsObserver.swift`: `MXMetricManager` subscriber, started in `LashKirjaApp.init`. MetricKit delivers the previous run's diagnostics, typically within a day of the crash, so there is no instant crash report.
- Server: `source` enum in `app/src/app/api/observe/route.ts` gained `"native"` (backward compatible, no schema or migration). Test: `route.test.ts`.

## Seeing one arrive on a local demo server

Events are not stored in a table. They are one JSON line on the server's stderr: `{"observe":true,"kind":"client_error","message":"api 500 GET /api/... app=1.0.0(1) ios=18.x","route":"native"}`. Filter the demo server's console for `"route":"native"`. If `OBSERVE_WEBHOOK_URL` is set it is also posted there. To trigger: sign in on the simulator, make any endpoint return 500 once.

## Not done

Not run in a simulator; the MetricKit path cannot be triggered on demand (Xcode: Debug > Simulate MetricKit Diagnostics works on a device).
