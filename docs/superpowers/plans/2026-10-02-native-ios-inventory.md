# LashKirja inventory for the native SwiftUI client (audit 2026-10-02)

Paths relative to `app/src/` unless noted. Shapes come from route code; "unverified" marks what was not read.

## 1. Auth (mobile = bearer token, never cookies)
- Calls go to `API_BASE_URL + path`, `credentials: "omit"`, `Authorization: Bearer <token>` (`lib/auth-client.ts`, `components/clientFetch.ts`).
- Token kept in Keychain (`lashkirja.auth.v1`) as `{token, expiresAt, issuedAt, userId}`. TTL 30 days (`lib/auth-credential.ts`). Client refreshes when older than 7 days, on launch, on resume and every 6 h in foreground. Refresh refused when the AuthSession row is older than 90 days → log in again.
- Any 401: wipe local state, go to login; "Istunto vanheni" only if a session existed.
- Logout: `POST /api/auth/logout` with bearer, 8 s timeout; on failure keep the token as pending-revoke and retry later; clear local state either way.

| Purpose | Request | Response | Errors |
|---|---|---|---|
| Login `POST /api/auth/token` | `{email, password, device:"ios-app"}` (≤32 KB) | `{token, tokenType:"Bearer", expiresAt: ISO, user:{userId, email, firstName}}` | `{error}` 400/401/403/429 (+Retry-After) |
| Refresh `POST /api/auth/token/refresh` | bearer only, no body | same as login | 401 `{error:{code:"UNAUTHORIZED", message}}`; 429 (30/h/session) |
| Logout `POST /api/auth/logout` | bearer | `{ok:true}` | — |
| Me `GET /api/auth/me` | bearer | `{user:{userId,email,firstName}}` | 401 `{user:null}` |
| Sessions `GET /api/auth/sessions` | | `{sessions:[...]}` | |
| Sessions `POST /api/auth/sessions` | `{scope?:"others"\|"all", id?}` | `{ok, signedOut}` | |
| Password `POST /api/auth/password` | `{currentPassword, newPassword}` | `{ok:true}` | 429 (5/15 min) |
| Forgot `POST /api/auth/password/forgot` | `{email}` | `{ok, mailConfigured, message}` | |
| Reset `POST /api/auth/password/reset` | `{token, password}` | `{ok:true}` | |
| Email `POST /api/auth/email` | `{email, currentPassword}` | unverified | |
| Confirm `POST /api/auth/email/confirm` | `{token}` | `{ok, email}` | |

`/api/auth/login` is the web cookie login; never from the app.

Passkeys: `GET /api/auth/passkey/status` → `{web, native}`; `POST .../authenticate/options` `{}` → `{challengeId, options}` (WebAuthn request JSON, base64url); `POST .../authenticate/verify` `{challengeId, response:{id, rawId, type:"public-key", response:{clientDataJSON, authenticatorData, signature, userHandle?}}, transport:"bearer", device:"ios-app"}` → token body. Register: `POST .../register/options` `{currentPassword}` → `{challengeId, options}`; `POST .../register/verify` `{challengeId, response:{id, rawId, type, response:{clientDataJSON, attestationObject, transports}}, deviceName?, device?}`. Manage: `GET /api/auth/passkey` → `{passkeys:[{id, deviceName, createdAt, lastUsedAt}]}`; `PATCH/DELETE /api/auth/passkey/{id}`. Native: `ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier:)`, entitlement `webcredentials:<host>`, AASA served at `/.well-known/apple-app-site-association`.

App lock (client only): PIN 4–8 digits, stored per user `{salt, hash}` with hash = SHA-256(`"salt:pin"`), 16-byte hex salt. Backoff 1,2,4,8,16 s then 30 s cap. Face ID flag per user. "Forgot PIN" clears the lock.

Write guards (`lib/http-security.ts`): `rejectCrossSite` passes when there is no `Origin`; 403 on `Sec-Fetch-Site: cross-site`. Body caps (256 KB JSON default). No CSRF token, no `X-Requested-With`. `Idempotency-Key` (UUID ≤80): honoured by `POST /api/invoices`, `POST /api/customers`, `POST /api/invoices/{id}/payments`, `POST /api/invoices/{id}/send`; REQUIRED by `POST /api/receipts/inbox`; reuse with a different body → 409 `IDEMPOTENCY_PAYLOAD_MISMATCH`.

Errors: `{error:"text"}` or `{error:{code, message, details?:[{field,message}]}}`. Codes: UNAUTHORIZED, INVALID_JSON, DATABASE_CONSTRAINT (409), NOT_FOUND, INTERNAL_ERROR, CONFLICT. PATCH of invoice, customer, receipt accepts `expectedUpdatedAt` → 409 on mismatch.

## 2. API base and CORS
- Base baked at build (`lib/build-target.ts`). CORS only for `capacitor://localhost`; a native URLSession sends no Origin and needs no CORS.
- Every `/api/*` response has `X-LashKirja-Api-Version: 1`; a 502/503/504 without it is a gateway error → GET retried 3× (500 ms × 2ⁿ), 25 s timeout.
- Public prefixes: `/api/auth/`, `/api/cron/`, `/api/health`.
- URLSession: no Origin, bearer header, no cookies, https only (ATS).

## 3. Screens
Tabs: Koti `/dashboard`, Myynti `/laskut`, Kirjanpito `/kirjanpito`, Raportit `/raportit`; Asetukset via avatar sheet. Details use query params (`?id=`). Launch warms: `/api/dashboard?month=`, `/api/invoices?`, `/api/receipts?sort=date_desc`, `/api/receipts?reviewStatus=pending`, `/api/statements`, `/api/bank-accounts`.

Shell: header Avustaja (AI) + avatar sheet (Asetukset, sign out). "+" sheet: Kuvaa kuitti (camera → `/kuitit/uusi?from=camera[&transactionId=]`), Tuo tiliote (document picker CSV/XLSX/camt/PDF → `/pankki/tapahtumat`), Uusi lasku, Hae sähköpostista (`/asetukset/sahkoposti`). Onboarding gate `GET /api/onboarding` (if `onboarded:false` → chat onboarding, `POST /api/onboarding`; "Ohita nyt" snoozes 24 h). Connectivity via `/api/health`. Client errors to `POST /api/observe`.

Signed out: `/login` (password via `/api/auth/token`, passkey), `/unohtunut-salasana`, `/palauta-salasana?token=`, `/vahvista-sahkoposti?token=`. No register screen.

Koti: `GET /api/dashboard?month=YYYY-MM`. Month switcher, greeting, income/expenses, matching progress, task items, setup card, Rahatilanne (bank total + trend), cards (Pankkitilit, open sales, open purchases), "Hoidettu automaattisesti". Actions: `PATCH /api/receipts/{id}/review {reviewStatus:"approved"}`; `POST /api/invoices/{id}/payments` (Idempotency-Key), undo `DELETE ...?paymentId=`.

Myynti: `GET /api/invoices?status=&month=&search=`, `/api/invoices/counts`, `/api/customers`, `/api/recurring-invoices`; match `GET` dry run then `POST /api/invoices/match`.
- `/laskut/uusi` (`?edit=`, `?customerId=`): InvoiceForm, catalog `GET/POST /api/catalog`, quick customer `POST /api/customers`, `POST /api/invoices` or `PATCH /api/invoices/{id}`.
- `/laskut/lasku?id=`: `GET /api/invoices/{id}`; PDF `/api/invoices/{id}/pdf`; send `GET` preview, `POST .../send {to?, subject?, message?}`; payments `POST {amount, paidDate, transactionId?, note?}`, `DELETE ?paymentId=`; `GET .../payments/candidates`; `POST .../payments/link {action:"link", paymentId, transactionId}` or `{action:"dismiss", paymentId, receiptId}`; `POST .../status {status, closeReason?}`; `POST .../credit`; `POST .../duplicate`; `DELETE` (drafts); reminders `GET/POST .../reminders`, `.../reminders/pdf`. Sections Rivit, Maksut, Muistutukset, Historia.
- `/asiakkaat`: `GET /api/customers?search=&includeArchived=1`, `POST`, import `POST /api/customers/import {csv, commit?}`. `/asiakkaat/asiakas?id=`: `GET/PATCH/DELETE /api/customers/{id}`; merge `POST /api/customers/merge {keepId, mergeId}`.
- `/toistuvat`: `GET /api/recurring-invoices[?inactive]`, `POST`, `PATCH/DELETE /{id}`, `GET/POST /api/recurring-invoices/run`.

Kirjanpito: `GET /api/dashboard?month=`, `/api/period-lock`, `/api/purchase-invoices/counts`, `/api/bank/connections`, `/api/alv?period=`. Hub cards + progress ring + BankConnectCard.
- `/kuitit`: `GET /api/receipts?offset&month&q&type&category&source&minAmount&maxAmount&sort&reviewStatus&linkedStatus`, `/api/receipts/counts`; `PATCH /{id}/review`, `POST /api/receipts/batch-approve {receiptIds}`, `POST batch-delete {receiptIds}`.
- `/kuitit/uusi`: upload `POST /api/receipts` multipart `file` → `{extracted, uploadId, filePath, originalName, status:"done"}` or `{jobId, status, uploadId, filePath, originalName}`; poll `GET /api/jobs/{jobId}` every 1.5 s; duplicate 409 `{code:"DUPLICATE_DOCUMENT", receiptId}`. Save `POST /api/receipts/save`. Vendor rules `GET/POST /api/vendor-rules`, `/undo`. Matching `POST /api/matching/confirm|unlink`.
- `/kuitit/kuitti?id=`: `GET/PATCH/DELETE /api/receipts/{id}`, image `/api/receipts/{id}/file` (`/file/preview`).
- `/pankki/tapahtumat?nayta=`: `GET /api/statements?month=`, sync `POST /api/bank/connections/{id}/sync`; row sheet (confirm/ignore/reject/unlink, batch-approve), statement upload.
- `/pankki/tapahtumat/tiliote?id=`: `GET/PATCH/DELETE /api/statements/{id}`; `PATCH/DELETE .../transactions`; `POST .../reinfer-types`; `GET /api/matching/candidates?transactionId=`; `POST /api/matching/run|confirm-all|...`.
- `/kirjanpito/pankkitilit`: `GET /api/bank-accounts[?includeArchived=1]`, `POST`, `GET/PATCH/DELETE /{id}`, balances `GET/PUT/DELETE /{id}/balances`; bank connection connect/scope `PATCH /api/bank/connections/{id}` / `DELETE`; statement files.
- `/kirjanpito/ostolaskut`: `GET /api/purchase-invoices?status=all|open|paid|cancelled|overdue`, `/counts`, `POST`, `GET/PATCH/DELETE /{id}`, payments `POST/DELETE /{id}/payments`, `GET /{id}/receipts`, `POST /api/purchase-invoices/match`.
- `/kirjanpito/alv`: `GET /api/alv?period=YYYY-MM|YYYY-Qn|YYYY`; `PATCH /api/alv/filing {period, filed?, paid?}`.
- `/kirjanpito/kuukausi?month=`: `GET /api/dashboard/month?month=`, `PUT /api/period-lock {month, reopen?, expectedLockedThrough?}`.
- `/kirjanpito/kaudet`: `GET/PUT /api/period-lock`, `GET /api/period-lock/precheck?month=`.
- `/tyot`: `GET /api/work-queue`, `GET /api/jobs`, `POST /api/jobs/{id}/retry|cancel`.

Raportit: `GET /api/reports/profit-loss?from=&to=` → `{from, to, total, months[], undatedCount, excludedReceiptCount, suspectedDuplicateCount, basis}`; CSV `GET /api/export?type=receipts|transactions|invoices|purchase-invoices|customers|profit-loss&year=|month=`; package `GET /api/export/package?month=`.

Asetukset (`GET /api/profile`): `/profiili` (`POST /api/auth/email`), `/yritys` + `/laskutus` (`PATCH /api/profile` with entityType, vatRegistered, vatPeriod, businessName, businessId, addressStreet, addressPostalCode, addressCity, phone, invoiceIban, invoiceBic, invoiceTerms, lateInterestPercent, reminderFee), `/tili`, `/tili/salasana`, `/tili/laitteet` (sessions), `/turvallisuus` (`/lukitus` PIN, `/biometria`, `/paasyavaimet`), `/tietosuoja` (`GET/POST /api/account/request`, `GET /api/account/request/{id}/package`), `/sahkoposti` (`POST/DELETE /api/integrations/imap`, `POST /api/integrations/imap/sync`), `/ohje`.

## 4. Endpoints (methods)
account/request GET POST; account/request/[id]/package GET. ai/chat GET POST PATCH; ai/conversations GET POST PATCH; ai/status GET. alv GET; alv/filing PATCH. bank-accounts GET POST; [id] GET PATCH DELETE; [id]/balances GET PUT DELETE. bank/aspsps GET; bank/connections GET POST; connections/callback POST; connections/[id] PATCH DELETE; connections/[id]/sync POST; bank/logo GET. catalog GET POST. customers GET POST; [id] GET PATCH DELETE; import POST; merge POST. dashboard GET; dashboard/month GET. export GET; export/package GET. health GET. integrations/imap POST DELETE; imap/sync POST. invoices GET POST; counts/overdue/sequence GET (sequence PUT); match GET POST; invoices/[id] GET PATCH DELETE; credit/duplicate/status POST; payments POST DELETE; payments/candidates GET; payments/link POST; pdf, reminders/pdf GET; reminders, send GET POST. jobs GET; [id] GET; [id]/cancel, [id]/retry POST. matching candidates/unmatched GET; confirm/confirm-all/ignore/reject/run/unlink POST. observe POST; onboarding GET POST; period-lock GET PUT; period-lock/precheck GET; profile GET PATCH. purchase-invoices GET POST; counts GET; match POST; [id] GET PATCH DELETE; [id]/payments POST DELETE; [id]/receipts GET. receipts GET POST; [id] GET PATCH DELETE; [id]/review PATCH; [id]/file, [id]/file/preview GET; counts GET; batch-approve/batch-delete/inbox/save POST. recurring-invoices GET POST; [id] GET PATCH DELETE; run GET POST. reports/profit-loss GET. statements GET POST(multipart); [id] GET PATCH DELETE; [id]/transactions PATCH DELETE; [id]/reinfer-types POST. uploads/[fileName](/preview) GET. vendor-rules GET POST; undo POST. work-queue GET.

## 5. Key shapes (money = euro number ≤2 decimals; dates YYYY-MM-DD; months YYYY-MM)
1. `GET /api/dashboard?month` → firstName, month, income, expenses, source ("tiliote"|"kuitit"), basis, txCount, receiptCount, invoiceCount, pendingReceiptsCount, matching {matchable, matched, suggested}, events, handled|null, estimatedVat, isRefund, vat {registered, entityType, ytdRevenue, threshold}, hasImap, bank {totalBalance, accountCount, needsAttention, state, hasBalance, reconnectBank}|null, bankTrend {points}|null, cashflow, receivables, payables, items: DashboardItem[], itemTotals, blockingTotal, previousMonth, setup, isSingleVatProfile, singleVatRate, sectionErrors?. DashboardItem.kind: overdue_invoice (remind), pending_receipt (approve), vat_gap (add_vat), invoice_match (confirm_match), missing_receipt (add_photo), receipt_match (review_match), payment_duplicate / draft_invoice (open_invoice). Fields per kind: `app/api/dashboard/items.ts:32-123`.
2. `GET /api/invoices` → `{invoices: PublicInvoice[] (+nextReminderAt), aging:{buckets, totalOpenCents, overdueCents, overdueCount, totalOpen, overdue, paidRecentCents}}`. PublicInvoice (`lib/sales-invoices.ts:222`): id, number, reference, status (draft|sent|paid|credited), displayStatus (+overdue), issueDate, dueDate, sentAt, paidAt, updatedAt, notes, currency, net, vat, gross, paid, open, closedReason, documentKind (invoice|credit_note), creditsInvoice, creditNotes[], customer {id, name, email, businessId}, lines [{id, description, quantity, unit, unitPrice, vatRate, net}], payments [{id, paidDate, amount, source, transactionId, note}], sends[], activity[].
3. `POST /api/invoices` (strict): `{customerId: uuid, issueDate, paymentTermDays?: 0..365, dueDate?, notes?, lines:[{description, quantity, unit?, unitPrice, vatRate}] (1..200)}` → 201 `{invoice}`.
4. `PATCH /api/invoices/{id}`: same, optional, + expectedUpdatedAt → `{invoice}`. `GET` → `{invoice, paymentDuplicates}`.
5. `POST /api/invoices/{id}/payments` `{amount, paidDate, transactionId?, note?}` → 201 `{invoice}`.
6. `POST /api/invoices/{id}/send` `{to?, subject?, message?}` → `{ok, sentTo, messageId, recorded, notice, invoice, replayed?}`; `GET` → `{preview}`.
7. `POST /api/invoices/{id}/status` `{status, closeReason? (3-500)}`.
8. Customers: `POST {name, businessId?, contactPerson?, email?, phone?, addressStreet?, addressPostalCode?, addressCity?, country?(2), defaultPaymentTermDays?, notes?}` → 201 `{customer}`. `GET` → `{customers: CustomerWithStats[]}` (+invoiceCount, openInvoiceCount, openBalance, invoicedTotal, lastInvoiceDate). `PATCH /{id}` same + archived + expectedUpdatedAt.
9. `POST /api/receipts` multipart `file` (see Kuitit); 429 with Retry-After.
10. `GET /api/jobs/{id}` → `{job:{id?, status, title, detail, error, progressLabel, resourceType, resourceId, createdAt, startedAt, finishedAt, extracted}}`; status done|failed|cancelled|…; extracted = `{source, confidence, rawText, vendor, date, totalAmount, category, notes, type, vatDetails:[{rate, amount}], reference, invoiceNumber, fieldConfidence, unreadable?}`.
11. `POST /api/receipts/save` (strict): `{uploadId: uuid, vendor?, date?, totalAmount?, vatDetails?:[{rate, amount}], category?, notes?, type:"meno"|"tulo", reference?, invoiceNumber?, forceDuplicate?}`; duplicate 409. Success body not fully read.
12. `GET /api/receipts` → `{receipts, count, truncated}`; receipt: id, vendor, date, totalAmount, category, type, reference, invoiceNumber, fileName, source, confidence, createdAt, updatedAt, reviewStatus (unverified), linkedTransaction {id, date, counterparty, amount, matchScore, matchReasons, statement {periodMonth, fileName}}|null, match {status, suggestedTransaction, matchCandidates[], candidatesDeferred}. `GET /api/receipts/{id}` → `{receipt}` with full matchCandidates.
13. `PATCH /api/receipts/{id}`: save fields (no uploadId) + expectedUpdatedAt. `PATCH .../review {reviewStatus: approved|rejected|pending}` → `{success, reviewStatus, autoLinked}`.
14. `POST /api/receipts/inbox` multipart `file` + `capturedAt`, header Idempotency-Key required → 201 `{status:"queued", jobId, uploadId}` or `{status:"duplicate", receiptId}`.
15. `GET /api/receipts/counts` → `{counts:{all, tulo, meno, linked, unlinked}}`.
16. `POST /api/statements` multipart `file` (+bankAccountId?) → `{ok, statement, statements, transactions, count, skippedDuplicates, heldBack, notice}`. `GET /api/statements?month` → `{statements}`.
17. `PATCH /api/statements/{id}/transactions` `{transactionId, type?: meno|tulo|oma_siirto|palkka, amount?, counterparty?, message?, reference?, …}`; `DELETE {transactionId}`.
18. Matching: confirm `{transactionId, receiptId}`; reject same; ignore `{transactionId, ignored?}`; unlink `{transactionId}` → `{ok, restoredSale}`; confirm-all `{statementId?, periodMonth?}` → `{ok, confirmed}`; run → `{ok, …, draftsCreated}`.
19. `GET /api/alv?period` → `{period:{key, start, end}, vatRegistered, field301|302|303|309|307|308:{label, …}, review, receiptCount, sources, excludedReceiptCount, suspectedDuplicateCount, skippedPurchaseInvoiceCount, suspectedPurchaseDuplicateCount}`.
20. Period lock `GET` → `{lockedThrough}`; `PUT {month, reopen?, expectedLockedThrough?}`.
21. Onboarding `GET` → `{onboarded, profile}`; `POST {entityType: toiminimi|kevytyrittaja|oy, vatRegistered, vatPeriod: month|quarter|year, salesTypes[], expenseCategories[], summaryNote?}` → `{success, profile}`.
22. Profile `GET` → `{profile}`.
23. Purchase invoices `POST {supplierName, supplierBusinessId?, supplierIban?, invoiceNumber?, reference?, (amount/date fields unverified), category?, notes?, receiptId?}`; `PATCH` + status (open|paid|cancelled) + closeReason.
24. Bank accounts `GET` → overview + `connected {accountCount, accounts}` + `combined {state, accountCount, totalBalance, excludedCurrencies, reconnectBank}`; `POST {name, bankName?, iban?, bic?, currency, isDefault?, …}`.
25. `GET /api/bank/connections` → `{enabled, ready, message?, connections:[{id, aspspName, aspspCountry, aspspLogo, psuType, status, validUntil, lastSyncAt, lastSuccessAt, lastError, accounts[]}]}`.

## 6. Native capabilities
Camera/photo capture → multipart `/api/receipts` (or `/api/receipts/inbox` offline); document picker for statements; authed file viewing (`/api/invoices/{id}/pdf`, `/api/receipts/{id}/file`, `/api/uploads/{key}`, export CSVs; filename from Content-Disposition) → QuickLook/PDFKit with share; haptics; Face ID (LocalAuthentication); Keychain; network status (NWPathMonitor); external links/bank auth (SFSafariViewController / ASWebAuthenticationSession); passkeys (AuthenticationServices). No push/local notifications. URL scheme `lashkirja`; only `lashkirja://bank/callback?...` handled.

## 7. Bank connect (Enable Banking)
1. `GET /api/bank/aspsps?country=FI&psuType=personal|business` → `{aspsps:[{name, country, logo, psuTypes, maximumConsentValidity, beta}]}`; logos via `/api/bank/logo?src=<enablebanking url>` (bytes). 503 = server not configured.
2. `POST /api/bank/connections {aspspName, aspspCountry:"FI", psuType, client:"app", historyFrom?}` → `{url, connectionId}` (8/h). `client:"app"` prefixes state with `app1.`.
3. Open `url` in an auth browser; the bank redirects to the server page `/bank/callback?code&state`, which forwards to `lashkirja://bank/callback?code=..&state=..` (also `lashkirja:///bank/callback`). `error=access_denied|cancelled` = cancelled; `expired`/`login_required` = expired; missing code/state = error.
4. `POST /api/bank/connections/callback {code, state}` → `{ok, connection}` (dedupe per code:state).
5. Pick accounts: `PATCH /api/bank/connections/{id}` with account scope `{id, inScope}` list (wrapper key unverified). Sync `POST /{id}/sync`; disconnect `DELETE`.
ASWebAuthenticationSession(callbackURLScheme: "lashkirja") fits without server change.

## 8. AI chat
- `GET /api/ai/status` → `{available}`.
- `POST /api/ai/chat {message (≤4000), stream:true, clientId (8-80, idempotent), conversationId?}` (20/min); 404/409/429.
- SSE `text/event-stream`, `data: <json>\n\n`, no event names: `{conversationId, userMessageId}` → `{delta}`* → final `{done, incomplete?, status, id, replyToId, content, proposal|null, sources:[{kind?, label, href}], createdAt, limited, conversationId, error?}`; errors `{incomplete:true, status:"busy"|"failed", error}`. Do not retry or time out the POST. Use `URLSession.bytes(for:)`.
- proposal `{type:"match_proposal", transactionId, receiptId, txSummary, receiptSummary, confidenceScore, reasons[], limited?}`; decide `PATCH /api/ai/chat {id, decision:"accepted"|"rejected"}`.
- History `GET /api/ai/chat?conversationId=&before=&beforeId=` → `{messages:[{id, role, content, clientId, proposal, limited, sources, status, replyToId, conversationId, createdAt}], hasMore, conversation:{id, title, archivedAt}|null}`.
- Conversations `GET /api/ai/conversations?q=&archived=1&before=&beforeId=` → `{conversations:[{id, title, archivedAt, updatedAt, createdAt}], hasMore}`; `POST {title?}`; `PATCH {id, title?, archived?, deleted?}`. Lists only conversations with at least one message.

## Gaps not verified
Full bodies of `/api/receipts/save`, `/api/dashboard/month`, `/api/work-queue`, profile GET, purchase-invoice amount/date fields, bank-connection PATCH wrapper key, `/api/bank/logo` query (`src` per the v0.9.1 code).
