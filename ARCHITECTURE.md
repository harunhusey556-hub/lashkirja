# LashKirja — Codebase Architecture

_Generated 2026-08-05 via Explore agent sweep. App root: `app/`._

Kirjanpito (bookkeeping) web app for Finnish lash-technician sole traders. Next.js 16 (App Router) + TypeScript + Tailwind v4 + Prisma 7 + SQLite. AI/OCR receipt extraction, bank statement import, receipt↔transaction matching, ALV (VAT) reporting.

## 1. Top-level layout (`app/`)

| Path | Purpose |
|---|---|
| `src/app/` | Next.js App Router — pages + API routes |
| `src/components/` | Shared React client components |
| `src/lib/` | Core business logic (AI/OCR, parsers, matching, auth, storage, VAT) |
| `src/generated/prisma/` | Generated Prisma Client |
| `src/types/` | Shared TS types |
| `prisma/` | `schema.prisma`, `migrations/`, `seed.ts`, `dev.db` |
| `data/` | Runtime SQLite (`lashkirja.db`) + `data/uploads/` private file storage |
| `scripts/` | tsx/sh maintenance & background scripts (worker, backfill, cleanup, debug) |
| `tests/e2e/` | Playwright E2E tests |
| `ios/` | Capacitor iOS wrapper |
| `public/` | Static assets, PWA manifest |

## 2. Route map (`src/app/`)

**Pages** — all client components except where noted:
- `page.tsx` (server) — redirect `/dashboard` if session, else `/login`
- `login/page.tsx` + `LoginForm.tsx` — public login
- `dashboard/page.tsx` (server, `requireSession` → redirect `/login`) renders client `DashboardClient.tsx`
- `kuitit/page.tsx` — receipts list
- `kuitit/uusi/page.tsx` — new receipt upload/extract
- `kuitit/[id]/page.tsx` — receipt detail (`ReceiptEditor.tsx`)
- `tiliotteet/page.tsx` — bank statements list
- `tiliotteet/[id]/page.tsx` — statement detail + matching (`StatementDetailView`)
- `alv-raportti/page.tsx` — VAT report
- `asetukset/page.tsx` — settings (profile, IMAP, entity/VAT type)
- `not-found.tsx`, `error.tsx`, `global-error.tsx`

**Auth pattern**: only `/` and `/dashboard` are server-gated (redirect). All other pages are client components that call session-protected API routes and redirect to `/login` on 401 (`clientFetch.ts` → `isUnauthorized`/`redirectToLogin`).

**API routes** (`app/api/**/route.ts`) — all call `requireSession` except `auth/login`, `auth/logout`, `cron/*` (CRON_SECRET-gated):

- `auth/login` — bcrypt check (dummy-hash timing-safe), Zod validation, cross-site/content-length rejection, per-IP+per-account rate limit, iron-session cookie, JSON or form POST
- `auth/logout`, `auth/me`
- `dashboard` — summary aggregation
- `profile` — entityType/vatRegistered/vatPeriod
- `receipts` — GET list + POST staged upload (validate → `lib/ai.ts extractReceipt` → preview → `Upload` row, 24h TTL)
- `receipts/save` — confirm staged upload into real `Receipt`, sanitize, trigger `runMatching`
- `receipts/[id]` — GET/PATCH/DELETE
- `receipts/[id]/review` — approve/reject reviewStatus
- `receipts/[id]/file`, `receipts/[id]/file/preview` — stream file/preview (session-scoped)
- `statements` — list/upload (parsed via `lib/parsers.ts`)
- `statements/[id]`, `statements/[id]/transactions`, `statements/[id]/reinfer-types`
- `matching/{candidates,unmatched,run,confirm,confirm-all,reject,ignore,unlink}` — full match workflow (`lib/matching.ts`)
- `integrations/imap`, `integrations/imap/sync` — IMAP account mgmt (AES-256-GCM password), manual sync trigger
- `alv` — VAT report data (`lib/alv.ts`)
- `cron/cleanup` — expired upload sweep
- `cron/sync-email` — periodic IMAP sync (alt to `scripts/worker.ts`)

## 3. Prisma schema (`prisma/schema.prisma`, sqlite, client → `src/generated/prisma`)

- **User** — email(unique), passwordHash, name, `entityType`(kevytyrittaja|toiminimi), vatRegistered, vatPeriod(month|quarter|year). → Receipt, Statement, Upload, ImapAccount
- **Receipt** — userId; vendor, date, totalAmountCents, vatDetails(JSON), category, notes, type(meno|tulo), reference, invoiceNumber, filePath/fileName, source(manual/ai/ocr/email_sync), confidence, rawText, reviewStatus(default approved), optional 1:1 uploadId. Relations: linkedTransaction(1:1 confirmed), suggestedTransactions(1:many), rejections. Index `[userId,date]`, `[userId,createdAt]`
- **Statement** — userId; fileName/fileType/filePath, checksum(unique/user, dedupe), periodMonth("YYYY-MM"), periodSource. → Transaction[]
- **Transaction** — statementId(cascade); date, counterparty, amountCents, reference, message, type. Two receipt FKs: `receiptId`(unique, confirmed only) + `suggestedReceiptId`(non-exclusive). matchStatus(unmatched/suggested/confirmed/ignored), matchScore, matchReasons(JSON). → rejections
- **Upload** — userId(cascade); staging table. purpose(receipt/statement), storageKey(unique), originalName, mimeType, sizeBytes, sha256, extractedJson/extractionSource/confidence/rawText, expiresAt+claimedAt(TTL), optional back-ref to Receipt. Unique `[userId,sha256,purpose]`
- **MatchRejection** — per-(transaction,receipt) rejection record, cascade both sides
- **ImapAccount** — userId(cascade); email, host/port/tls, encryptedPass(AES-256-GCM), lastSyncAt

## 4. `lib/` modules

- **`ai.ts`** (1020L) — receipt extraction pipeline. MIME sniff from magic bytes, HEIC→JPEG (`heic-convert`), text extraction (`pdftotext`/`pdf-parse`, HTML strip, tesseract fin+swe+eng OCR, `ocrScannedPdfReceipt` via `pdftoppm`+tesseract). LLM routing in `extractReceipt`: if `isCloudAiEnabled()` (CLOUD_AI_ENABLED or LLM_API_KEY/COPILOT_GITHUB_TOKEN present) → tries LLM + Copilot, order flips **PDF=Copilot-first, other=LLM-first**, each falls through, final fallback = regex/heuristic `parseOCRText`. Finnish regex parsers (vendor/date/total/VAT/reference/invoice), VAT-rate validation (25.5/24/14/13.5/10/0%), `enrichExtractedReceipt` cross-checks `vat-rules.ts`.
- **`parsers.ts`** (1088L) — bank statement parsers: `parseCamtXML`(ISO 20022), `parseXLSX`, `parseCSV`, `parseHolviTilioteLayout`/`parseFinnishBankStatementLayout`(PDF layouts), `parsePDFStatement`(text+OCR fallback), generic `parseBankStatementText`. All → `ParsedTransaction[]`.
- **`session.ts`** — iron-session config, SESSION_SECRET ≥32 chars required in prod, cookie `__Host-lashkirja-session` when secure, `getSession`/`getSessionFromRequest`/`requireSession`/`redirectResponse`(app-relative guard, anti open-redirect)
- **`encryption.ts`** — AES-256-GCM for IMAP passwords, key = SHA-256(SESSION_SECRET) — **shared secret with session signing**
- **`storage.ts`** — private per-user upload storage: `detectFile`(magic bytes), `validateUploadBuffer`, `writePrivateUpload`/`readUserUpload`/`removeUserUpload`(0700/0600, O_NOFOLLOW, path-traversal-safe keys), `sha256`, `inlineContentDisposition`
- **`matching.ts`** (794L) — fuzzy receipt↔transaction matcher: `scorePair`(Levenshtein name sim, date diff, amount, reference), thresholds SUGGEST=0.85, CANDIDATE=0.55, AUTO_CONFIRM=0.85; `computeSuggestions`, `runMatching`, `confirmMatch`/`confirmAllSuggestions`(MatchNotFoundError/MatchConflictError), `buildReceiptMatchViews`, `buildInlineCandidates`
- **`mail-sync.ts`** — `syncImapAccount(accountId)` via ImapFlow+mailparser, filters attachment/body receipts, decrypts password
- **`income-automation.ts`** — `autoGenerateIncomeReceipts` — auto-creates "tulo" receipts from matched incoming transactions
- **`vat-rules.ts`** / **`alv.ts`** — Finnish VAT category hints, rate guessing, ALV report computation
- **`receipt-categories.ts`** — canonical category ids, AI-prompt formatting, normalization
- **`finnish-numbers.ts`** — Finnish decimal-comma amount/date regex helpers
- **`preview.ts`** — `ensureReceiptPreviewImage` thumbnail generation
- **`db.ts`** — Prisma client singleton
- **`http-security.ts`** — `rejectCrossSite`, `rejectOversizedContentLength`, `noStoreJson`
- **`rate-limit.ts`** — in-memory `consumeRateLimit`/`clearRateLimit`, `opaqueRateKey`, `requestClientKey`
- **`api-errors.ts`** — `withErrorHandler`, `UnauthorizedError`/`AppError`
- **`sanitizer.ts`** — user input text sanitization
- **`validation.ts`** — shared Zod schemas
- **`money.ts`** — cents↔euros conversion
- **`statement-api.ts`** / **`statement-client.ts`** — server vs client statement data shaping
- **`vero/omavero-fields.ts`** — OmaVero (Finnish tax authority) export field mapping

## 5. Key `components/`

- `AppShell.tsx` — authenticated layout chrome
- `ReceiptEditor.tsx` — receipt detail/edit form
- `ReceiptMatchPanel.tsx` — suggested/confirmed match UI (`BankTxMatch`/`ReceiptMatchData`)
- `ReceiptPreview.tsx` — stored file/preview display
- `StatementDetailView.tsx` — transaction table + matching UI
- `StatementSummaryCards.tsx` — stat cards
- `AsyncState.tsx` — `LoadingState`/`ErrorState`
- `ConfirmModal.tsx` — generic confirm dialog
- `ErrorBoundary.tsx` — React error boundary
- `SkeletonCard.tsx` — loading skeleton
- `clientFetch.ts` — `ApiError`, `apiFetch`(backoff retry 502/503/504), `readJson`, `isUnauthorized`, `errorMessage`, `redirectToLogin` — central client API/auth handling

## 6. `scripts/`

- `worker.ts` — long-running (10min interval) IMAP sync for all accounts, alt to cron route
- `seed.ts` (`prisma/seed.ts`) — DB seed
- `backfill-references.ts` — extract reference/invoiceNumber from stored rawText, no AI, re-runs matching
- `cleanup-uploads.ts` — `cleanupExpiredUploads()`, called from cron + worker
- `backup-db.sh`, `build-ios-ipa.sh`
- `check_imap.ts`, `check_suomifi.ts`, `find_yth.ts` — ad-hoc IMAP debug scripts
- `fix_receipts.ts` — one-off repair for email_sync receipts with legacy file paths
- `test_extraction.ts`, `test-parsers.ts`, `test-receipt-extract.ts`, `test_heic.mjs` — manual debug harnesses (outside Vitest)
- `update_categories.ts` (repo root) — category migration script

## 7. Env vars

| Var | Used in | Purpose |
|---|---|---|
| `DATABASE_URL` | prisma | SQLite connection |
| `SESSION_SECRET` | session.ts, encryption.ts | iron-session signing key (≥32 chars, prod-required); also derives AES key for IMAP passwords |
| `COOKIE_SECURE` | session.ts | override secure-cookie flag |
| `NODE_ENV` | session.ts, encryption.ts, cron | prod/dev switch |
| `CLOUD_AI_ENABLED` | ai.ts | explicit toggle for cloud LLM extraction |
| `LLM_API_KEY` | ai.ts | OpenAI-compatible key |
| `LLM_BASE_URL` | ai.ts | OpenAI-compatible base URL (default api.openai.com/v1) |
| `LLM_MODEL` | ai.ts | model name (default gpt-4o-mini) |
| `COPILOT_GITHUB_TOKEN` | ai.ts | GH token → exchanged for Copilot session token |
| `COPILOT_MODEL` | ai.ts | Copilot model (default gpt-4o) |
| `CRON_SECRET` | api/cron/* | bearer/query auth for cron routes; prod refuses without it |
| `ALLOWED_DEV_ORIGINS` | next.config.ts | dev-server allowed origins |
| `APP_ORIGIN` | http-security.ts | expected origin for CSRF-style same-origin check |
| `TRUST_PROXY` | rate-limit.ts | trust X-Forwarded-For for client IP |

## 8. Architectural patterns worth remembering

- **Two-phase upload/confirm**: file → staging `Upload` row (AI/OCR cached as JSON, 24h TTL) → explicit confirm into permanent `Receipt` via `receipts/save`. Unclaimed uploads swept by `cleanup-uploads.ts`.
- **LLM fallback chain** (`ai.ts`): order flips by file type (PDF=Copilot-first, else LLM-first), each falls through, final fallback = deterministic regex/heuristic parser — app works fully offline without any API key.
- **API routes over Server Actions** — everything effectful is `route.ts`; pages are thin client components via `clientFetch.ts`.
- **Auth split** — server redirect-gating only on `/` and `/dashboard`; rest rely on client-side 401→redirect.
- **Defense-in-depth file handling** — content-sniffed MIME (not trusting client type/ext), ext-vs-content match, 0700/0600 dirs/files, O_NOFOLLOW reads, path-traversal-safe keys, per-purpose size caps.
- **Matching engine** — scoring pipeline (Levenshtein name + date + amount + reference) with 3 tiers (candidate/suggest/auto-confirm) + explicit per-pair rejection tracking so one rejection doesn't block alternates.
- **Secret reuse** — `SESSION_SECRET` doubles as source key (via SHA-256) for IMAP password AES-256-GCM encryption.
- **Money as integer cents** throughout schema, `money.ts` conversion helpers — no float currency bugs.
- **Finnish-locale parsing pervasive** — comma-decimal amounts, dd.mm.yyyy dates, Finnish VAT rates, viitenumero/laskun numero patterns, OCR lang set fin+swe+eng.

## 9. Banking, receivables and reporting (added 2026-08-20)

### Domain modules (pure, unit-tested)

| Module | Responsibility |
|---|---|
| `lib/bank-balances.ts` | Month-end rollforward: opening + movement = computed closing, compared with the bank's reported closing. Anchors the next month on the reported figure when one exists; excludes and counts pre-opening and undated rows. Capped at `MAX_ROLLFORWARD_MONTHS`. |
| `lib/iban.ts` | ISO 13616 mod-97 validation (chunked, so a 34-char IBAN never loses precision), formatting, masking, Finnish bank-code hints, extraction of IBANs from statement text. |
| `lib/invoices.ts` | Invoice arithmetic in integer cents: quantities in thousandths, VAT rates in permille. VAT is computed per rate on the summed net. Also the lifecycle transition table and AR aging buckets. |
| `lib/finnish-reference.ts` | Viitenumero (7-3-1 mod 10) and Y-tunnus (mod 11) check digits, including the remainder-1 case that has no valid check digit. |
| `lib/reports.ts` | Profit and loss from receipts, per month and per category. A receipt with no VAT breakdown is counted gross and reported in `missingVat` — the rate is never guessed. |
| `lib/csv.ts` | Semicolon CSV with UTF-8 BOM, comma decimals, quoting and formula-injection guarding. |

### Persistence layer

`lib/bank-accounts.ts`, `lib/customers.ts`, `lib/sales-invoices.ts` hold everything that needs the
database (ownership checks, the per-user invoice number sequence, archive-instead-of-delete rules,
bank reconciliation). Routes stay thin: parse with zod, call the service, return `noStoreJson`.

### Rules that are enforced server-side, not in the UI

- A bank account or customer that owns history is archived, never deleted.
- `Statement.bankAccountId` is `SET NULL`: deleting an account cannot destroy bookkeeping evidence.
- `InvoicePayment.transactionId` is unique — one bank row can settle at most one invoice — and also
  `SET NULL`, so deleting a statement does not erase the fact that a customer paid.
- Only a draft invoice may be edited or deleted; crediting is terminal; an invoice with payments
  cannot return to draft.
- Automatic payment matching applies **only** on a viitenumero hit. An amount-only coincidence is
  returned as a suggestion and never posted.

### Testing layers

- `npm test` — pure logic (`src/**/*.test.ts`).
- `npm run test:integration` — `vitest.integration.config.ts`: a migrated SQLite file per test file,
  real App Router handlers invoked directly, genuinely sealed iron-session cookies. No mocks.
- `npm run test:e2e` — Playwright against a built server: login, tab-bar navigation, bank account
  creation and reconciliation, invoice draft → sent → paid, CSV download, security headers.

Three production defects were found by these layers rather than by review: an unmapped error type
turned invoice validation into HTTP 500; `chmod` on a database directory the process does not own
(for example `/tmp`) crashed every database-backed request; and the CSRF check compared the Origin
header against `req.nextUrl.origin`, which under `next start` does not carry the real host and so
rejected every same-origin form POST, login included.

## 10. VAT sources, payables, invoice documents (added 2026-08-20)

### One loader for the VAT period

`lib/alv-period.ts` is the single place that decides what a VAT period is made
of. Both `/api/alv` and the dashboard estimate call it, which is what stops the
front page and the return from drifting apart.

It also owns the double-counting rule: a receipt is excluded when the bank row
it was drafted from (`sourceTransactionId`), or the bank row it is
confirm-matched to, already settled a sales invoice. The exclusion is on
identity, never on resemblance of amount or date.

Sales invoices enter the return by issue date, `sent` and `paid` only. Drafts
and credit notes stay out, and the credited count is reported so a missing
figure is visible rather than mysterious.

### Payables are deliberately outside the books

`PurchaseInvoice` tracks what is owed. It does **not** feed the VAT return:
receipts remain the only purchase-VAT source, so recording a supplier invoice
and photographing its receipt cannot double-count. `receiptId` links the two.
Two integration tests pin this boundary so a later change cannot quietly cross
it.

Receivables and payables age through the same `buildAging`; only the definition
of "open" differs.

### Invoice documents

| Module | Responsibility |
|---|---|
| `lib/invoice-pdf.ts` | A4 invoice rendered with pdfkit: parties, lines, VAT breakdown per rate, payment block. |
| `lib/bank-barcode.ts` | Finnish virtuaaliviivakoodi v4 (54 digits) plus a decoder used to verify what was encoded. Returns null for a foreign IBAN, an RF reference or an amount the format cannot carry. |
| `lib/mailer.ts` | Sends through the IMAP account the user already connected. `MAIL_TRANSPORT=json` swaps in nodemailer's test transport so delivery is asserted without a mail server. |

`pdfkit` and `nodemailer` are listed in `serverExternalPackages`: pdfkit reads
its .afm metric files from node_modules at runtime, and bundling it made every
PDF request answer 500 in a production build while passing in tests. The
Playwright suite is what caught it — a reminder that unbundled integration
tests cannot see build-time packaging faults.

## 11. Reminders and closed books (added 2026-08-20)

### Late interest is configuration, not a constant

`lib/late-interest.ts` computes interest from a rate the user stores, never
from a rate baked into the app: Finnish late interest is the Bank of Finland
reference rate plus a statutory margin, and that reference rate changes every
six months. With no rate configured, no interest is charged at all — a
deliberately visible gap rather than a plausible wrong number. Interest runs
from the day after the due date, actual days over 365.

`lib/invoice-reminders.ts` refuses to produce a reminder unless the invoice is
sent, unpaid and actually overdue, and stores what was demanded on the day it
was sent (`InvoiceReminder`), so the figure stays reconstructible. The row is
written only after the mail server accepts the message.

### Closed books

`User.booksLockedThrough` is the last closed month. `lib/period-lock.ts`
exposes `assertPeriodOpen` / `assertMonthOpen`, called from the service layer
so every route inherits the rule:

| Domain | Guarded operations |
|---|---|
| Sales invoices | create, edit, status change, delete, payment add/remove |
| Purchase invoices | create, edit, delete, payment add/remove |
| Receipts | save, edit, delete, batch delete |
| Statements | upload, period change, delete |
| Bank balances | month-end balance set/clear |

Deletion is guarded as strictly as editing: removing a receipt changes a filed
return exactly as much as changing one. Bank reconciliation is the one place
that degrades instead of failing — a reference hit inside a closed period is
skipped and reported in `skippedLocked`, so one locked month cannot stop the
rest of a matching run.

Wrapping `statements/[id]` in `withErrorHandler` was part of this: those
handlers returned raw responses, so a thrown domain error would have surfaced
as a 500 instead of the 409 it is.
