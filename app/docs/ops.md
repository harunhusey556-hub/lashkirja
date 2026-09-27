# Operations

Reporting is off unless an environment variable turns a destination on. Logs never include a password, token, cookie, session, IBAN, or SMTP secret. Query timing records the model and the operation, not the SQL parameters.

## Environment

| Variable | Effect |
| --- | --- |
| `OBSERVE_WEBHOOK_URL` | POST each event as JSON. Unset means log only. |
| `SENTRY_DSN` | POST a minimal envelope for client errors, job failures, and a degraded health check. Unset means no Sentry call. |
| `SLOW_QUERY_MS` | Log a `slow_query` event at or above this many milliseconds. Default 200. |
| `HEALTH_TOKEN` | `Authorization: Bearer …` for `GET /api/health`. Required in production. Outside production the route is open when the token is unset. |
| `SMTP_HOST` | Marks mail as configured. The health check does not open an SMTP connection and does not print the host. |

The browser posts window errors to `POST /api/observe` for a logged-in session. The route keeps ten reports a minute and strips query strings.

A background job that fails calls the same reporter with the job kind and a short message. The document payload is not included.

## Health

`GET /api/health` separates four checks:

- `db` — `SELECT 1` and how long it took
- `disk` — `data/uploads` exists, is writable, and has at least 50 MB free
- `mail` — whether `SMTP_HOST` or a stored mailbox host is set. A machine with no mailbox is `configured: false` and still ok
- `bankJobs` — `bank_sync` jobs that failed in the last 24 hours

The response is 200 when db, disk, mail, and bank jobs are ok. Otherwise it is 503 and one JSON log line is written (`kind: health`). With `OBSERVE_WEBHOOK_URL` or `SENTRY_DSN` that same event is delivered. There is no separate email alerter: the operator watches the log or the webhook.

```bash
curl -fsS -H "Authorization: Bearer $HEALTH_TOKEN" https://example.invalid/api/health
```

A non-zero curl exit is the alert. Point a scheduler at that command if you want a page.

## Reliability

A cookie with a session id is accepted only while that `AuthSession` row is still live. Logout-all and a password reset also set `User.legacySessionsRevokedAt`, so a cookie that only has a user id stops working and the device must sign in again. See `app/docs/account-recovery.md`.

Create requests that send `Idempotency-Key` store the response in the same database transaction as the new row. A failed response write rolls the insert back. The same key with a different body is refused. A `processing` row older than two minutes can be claimed again.

A customer, invoice, or receipt save that sends `expectedUpdatedAt` updates with `WHERE id AND updatedAt = that instant`. Zero rows is a 409. Invoice line replacements run in that same transaction. An invoice send takes `sendLockToken` before the PDF is built; edits are refused until SMTP fails (safe to resend) or the outcome is stored. If SMTP accepted the message and the outcome was not stored, the lock stays and another send is refused as ambiguous. The sent PDF's sha256 and a document snapshot are kept on the invoice and on the send row.

Document analysis writes the extraction only when the job's `attemptToken` still matches the run that finished OCR. Cancel and retry clear that token first, so a late run cannot overwrite the new one.

Backups are described in `app/docs/backup.md`.

Account close, a data copy, and a password recovery that could not be mailed are `AccountRequest` rows. `npx tsx scripts/account-requests.ts list` shows them. `set <id> in_progress|needs_info|denied` moves an open row. `complete-export` writes `data/account-packages/<userId>/<id>.zip` and the user downloads it from Tietosuoja. `complete-close` sets `User.accessDisabledAt` and revokes sessions. Receipts and invoices stay for the retention period. Password links prefer `PLATFORM_SMTP_*` and do not require the user's invoice mailbox. See `app/docs/account-recovery.md`.

## What is not collected

Bank session secrets, mailbox passwords, invoice PDFs, and receipt files stay out of these events. A slow query does not log the bound values.
