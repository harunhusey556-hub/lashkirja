# Performance budgets

Measured in the integration suite on SQLite, not on a phone.

| Path | Data | Expectation | CI ceiling |
| --- | --- | --- | --- |
| `GET /api/receipts` | 2 500 receipts and 2 500 open bank rows | Page of 200, `truncated: true`, `count` is the full total. `matchCandidates` is empty. Scoring runs when one receipt is opened, not on this list. | 8 s |
| `GET /api/invoices` | 2 500 draft invoices | Page of 200. | 8 s |
| Transaction page | 2 500 rows on one statement | `count` is 2 500 and `take: 200` returns 200. Opening the statement screen still scores match candidates; that cost is not on the receipt list. | 8 s |

The design target for a receipt list page that does not score matches is 1.5 s. The ceiling above is what the test fails on, so a slow CI runner does not flap, and a return of the full candidate scan still fails.

The in-memory page cache keeps 40 entries for 5 minutes (`page-cache.ts`). Mobile persists a copy (Task 7); the web build stays memory-only.

## Client-side full load / tab switch (Task 6, A1-A4)

Measured on `:3200` (the dev server), Chrome via CDP throttle (150 ms RTT, 1.5 MB/s down/up, 4x CPU), n=10 samples each, median reported (`Math.floor`/`Math.ceil` midpoint average for an even count). One phone-sized viewport (390x844), one login, ten `/kirjanpito` full loads followed by ten tab switches (Raportit <-> Kirjanpito) in the same authenticated session. "Before" was measured by temporarily restoring the pre-Task-6 versions of `AppShell.tsx`, `AppLock.tsx`, `ShellGate.tsx`, `DashboardClient.tsx` and `useAccountId.ts` from git `HEAD` on the running dev server (it hot-reloads), then restoring the Task 6 versions for "after" -- both against the same server process, same throttle, same session.

| Metric | Before (A1-A3: sequential `/me`-then-render, no prefetch) | After (A1-A4: parallel render, shared `/me`, prefetched tabs) |
| --- | --- | --- |
| Full load of `/kirjanpito` (median of 10) | 5 260 ms | 499 ms |
| Tab switch, warm session (median of 10) | 808 ms | 643 ms |

The full-load gap is the larger of the two by far: removing the "Tarkistetaan istuntoa…" gate (page data no longer waits behind `/me`) is most of it. The tab-switch median still includes a couple of post-navigation-recompile samples in dev mode (the two runs happened right after two separate hot reloads); a warm, already-compiled route is close to the low end of each sample set (roughly 480-620 ms in both runs), which is consistent with `<Link prefetch>` on the four tab roots mostly eliminating the RSC round trip the previous `router.push`-only buttons always paid. Not re-measured against a `next build` production server (parallel-rules.md rule 5 forbids a web `next build` in this checkout); the *relative* improvement should hold, though absolute numbers would be lower under a production bundle.
