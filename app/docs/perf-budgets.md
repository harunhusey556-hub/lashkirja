# Performance budgets

Measured in the integration suite on SQLite, not on a phone.

| Path | Data | Expectation | CI ceiling |
| --- | --- | --- | --- |
| `GET /api/receipts` | 2 500 receipts and 2 500 open bank rows | Page of 200, `truncated: true`, `count` is the full total. `matchCandidates` is empty. Scoring runs when one receipt is opened, not on this list. | 8 s |
| `GET /api/invoices` | 2 500 draft invoices | Page of 200. | 8 s |
| Transaction page | 2 500 rows on one statement | `count` is 2 500 and `take: 200` returns 200. Opening the statement screen still scores match candidates; that cost is not on the receipt list. | 8 s |

The design target for a receipt list page that does not score matches is 1.5 s. The ceiling above is what the test fails on, so a slow CI runner does not flap, and a return of the full candidate scan still fails.

The in-memory page cache keeps 40 entries for 5 minutes (`page-cache.ts`). It is not persisted.
