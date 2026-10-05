# P0.3 — every network-backed screen has explicit states (2026-10-05)

Branch `feature/screen-states` from `origin/native` (`200bc96`).

## Finding

There was a shared layer already: `Loadable<Value>` (`idle/loading/loaded/failed(String)`) and the
`LoadState` view in `App/Sources/Components/Components.swift`, the global `OfflineBanner`
(`Shell/Connectivity.swift`, NWPathMonitor), `ReloadGate` (when to reload), and `APIClient`
(GET retries a gateway 502/503/504 three times; a 401 that ends the current session calls
`AppModel.sessionExpired()` → sign-in with "Istunto vanheni. Kirjaudu uudelleen.").

Gaps:

1. **Offline, timeout and server-down looked the same.** `APIClient.transportError` turned every
   `URLError` into `NETWORK` + "Palvelimeen ei saada yhteyttä…", so airplane mode read as a
   server problem. The `LoadState` failure title was always "Lataus epäonnistui" with a wifi icon.
2. **A failed refresh over shown data was silent on most screens.** The common pattern
   `if state.value == nil { state = .failed(...) }` kept the old data (good) but said nothing, so
   stale figures looked current. Koti stepping to another month and failing showed the *old*
   month's figures under the new month's title with no hint.
3. Some screens put the refresh failure in the same red `failure` text as mutation errors
   (Receipts, Ostolaskut), in raw server words.
4. Raportit and a handful of sheets reset to a full spinner on every load (Raportit only on a
   year change, which is intended).

## Shared layer (new)

- `LashKirjaCore/Net/ScreenLoad.swift`
  - `LoadFailure` / `LoadFailureKind`: `offline` (no network, request never left), `timeout`
    (`URLError.timedOut`, 504), `unavailable` (502/503, refused/lost connection), `sessionExpired`
    (401 that ends the session; no retry button), `unreadable` (decode), `server` (server's own
    Finnish sentence). Finnish title + message: what failed and what to do next; no codes.
    `nil` for cancellation.
  - `ScreenLoad<Value>`: `begin()` (spinner only with nothing shown, otherwise `refreshing`),
    `succeed`, `fail` (with data → keeps data, `banner` set; without → full failure view;
    cancelled → nothing changes), `restart()` (another subject, e.g. year), `update` (local edits).
- `APIClient.transportError`: `notConnectedToInternet/dataNotAllowed/internationalRoamingOff` →
  `OFFLINE` with "Ei verkkoyhteyttä. Mitään ei lähetetty; yritä uudelleen, kun yhteys palaa.";
  `timedOut` → `TIMEOUT`; the rest stay `NETWORK`. All still `status 0` (upload queue, POS
  unchanged). `InvoiceSendResult.failureMessage` treats `TIMEOUT` like `NETWORK` ("we don't know
  whether it left; retry is safe").
- App: `ScreenStateView` (spinner / `LoadFailureView` / content + banner),
  `RefreshFailureBanner` (kind icon, title, "Näytetään viimeksi haetut tiedot.", "Yritä uudelleen"
  with in-flight spinner), `LoadFailureView` (no retry for an ended session).
- Tests: `LashKirjaCoreTests/ScreenStateTests.swift` (classification: 401, offline URLErrors,
  timeout vs offline, 502/503/504, decode, server sentence, no raw codes in copy; transitions:
  first load, refresh keeps data, failure with/without data, cancellation, restart, update).

## Audit

States: L = initial loading, R = background refresh keeps data, E = empty, P = partial,
F = recoverable error + retry, S = session expired, O = offline, T = timeout/gateway,
M = successful mutation. "silent" = refresh failure not shown. Global: `OfflineBanner` on all
tabs; 401 → sign-in screen with notice (all screens).

| Screen | Before | After |
|---|---|---|
| **Koti** (`KotiModel`) | L, R, E (first-run card), P (`sectionErrors` notice; VAT/jobs fail quietly), F full only, refresh/month-step **silent**, M toast + undo | **ScreenLoad**: banner on failed refresh/month step; O/T/S told apart |
| Koti tasks (dashboard items) | part of Koti dashboard; optimistic hide + undo toast | same, covered by Koti |
| **Myynti** invoice list | L, R, E ("Ei laskuja…"), P (counts fail → chips without counts), refresh **silent** | **ScreenLoad** + banner |
| **Kirjanpito** hub | navigation hub; three count subtitles via `try?` fall back to static text (P) | unchanged (works offline by design) |
| **Raportit** | L, year change = deliberate full reload, refresh **silent** | **ScreenLoad** (`restart` on year change) + banner |
| Kuitit (`ReceiptsView`) | L, R, E, refresh error as red raw text mixed with action errors | **ScreenLoad** + banner; red text now only action errors |
| Pankkitapahtumat (`BankFeedView`) | L, R, E (ContentUnavailable), refresh **silent** | **ScreenLoad** + banner |
| Ostolaskut list | L, R, E, refresh error as red raw text | **ScreenLoad** + banner |
| Asetukset root | profile failure inline text; menu usable | unchanged |
| Invoice detail | L, R, refresh silent, M notice/toast | P0.3 kalan |
| Customers list / detail | L, R, E, refresh silent | P0.3 kalan |
| Toistuvat laskut | L, R, refresh error as notice | P0.3 kalan |
| Receipt detail | L, R, refresh error as red text | P0.3 kalan |
| Ostolasku detail | L, R, refresh error as red text | P0.3 kalan |
| Toistuvat ostot | L, R, refresh error toast | P0.3 kalan |
| Pankki hub, Tiliotteet, Tiliote detail | L, R, refresh silent | P0.3 kalan |
| Sähköposti inbox | L, R, refresh error red text | P0.3 kalan |
| Tuonnit ja virheet (`WorkQueueView`) | L, R, refresh error note (BOOKS-16) | P0.3 kalan (already shows it) |
| ALV (`AlvView`) | period change → spinner (intended), failure replaces | P0.3 kalan |
| Kuukauden sulku (`PeriodsView`) | month status failure replaces data | P0.3 kalan |
| Pankkitilit rollforward / bank picker | rollforward silent; picker reload = spinner | P0.3 kalan |
| Sheets: Koti approval, bank match (Myynti), bank candidates, purchase↔bank link, send preview | one-shot loads; failure replaces sheet body | P0.3 kalan (one-shot, low risk) |
| Asetukset subpages: sessions, passkeys, privacy, email import, change email, templates, payments | sessions/passkeys/privacy/import: refresh failure **replaces** list | P0.3 kalan |
| Assistant (chat) | own streaming states (P4) | out of scope |

Server: no route returned a shape that hides a state; no server change.

## P0.3 kalan

Move to `ScreenLoad` + `RefreshFailureBanner`: InvoiceDetail, Customers (list+detail),
RecurringInvoices, ReceiptDetail, PurchaseInvoiceDetail, RecurringPurchases, BankHub, Statements,
StatementDetail, EmailInbox, WorkQueue, AlvView, PeriodsView, BankAccounts (rollforward, picker),
the five load sheets, Asetukset subpages (SettingsView sessions, Passkeys, Privacy, EmailImport,
ChangeEmail, EmailTemplates, PaymentsSettings). The old `Loadable`/`LoadState` stays until then.

## Cihaz kontrol listesi (TR)

1. Koti açıkken uçak modunu aç, aşağı çekip yenile: rakamlar kalmalı, üstte "Ei verkkoyhteyttä" + "Näytetään viimeksi haetut tiedot." bandı çıkmalı; tam ekran spinner olmamalı.
2. Uçak modunda uygulamayı kapatıp aç, Myynti'ye gir: "Ei verkkoyhteyttä" ekranı + "Yritä uudelleen"; uçak modunu kapat, butona bas → liste gelmeli.
3. Koti'de önceki aya geç (oklar) uçak modunda: eski ay rakamlarının üstünde hata bandı görünmeli.
4. Sunucu kapalıyken (PC'de server durdur) Kuitit ve Pankkitapahtumat'ı yenile: "Palvelimeen ei saada yhteyttä" bandı, liste yerinde kalmalı.
5. Raportit'te yıl değiştir: yeni yıl yüklenirken eski yılın rakamları görünmemeli; yüklenince bant kalmamalı.
6. Ostolaskut'ta bant varken "Yritä uudelleen"e bas: buton yerinde spinner, başarıda bant kaybolmalı.
