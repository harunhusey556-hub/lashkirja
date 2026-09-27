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

## What is not collected

Bank session secrets, mailbox passwords, invoice PDFs, and receipt files stay out of these events. A slow query does not log the bound values.
