# P0.2 part 1 — important mutations cannot be double-submitted (2026-10-05)

Branch `feature/mutation-double-submit` from `origin/native` (contains `9ace29e`).

## How a double submit happens in this app

Almost every action is `Button { Task { await save() } }` with `@State busy`, and `busy = true`
is set inside the async function. `.disabled(busy)` only takes effect after the next render, so two
taps in quick succession queue two `Task`s; without a `guard !busy` at the top of the function, the
second Task runs while the first awaits the network and sends the request again.

Server side (`app/src/lib/idempotency.ts`): a refused or failed attempt releases its key; the same
key with a different body is refused (`IDEMPOTENCY_PAYLOAD_MISMATCH`); a lost answer is replayed.
So the right client rule is **one key per user action until it succeeds**, also across edits.

## Inventory (before the fix)

"Guard" = re-entrant call returns before sending. "Key" = route accepts `Idempotency-Key` / client sends one and reuses it on retry.

| Action | View / file | Disabled in flight | Second tap / re-entrant Task could send again | Server idempotency | Client key, reused on retry | Gap |
|---|---|---|---|---|---|---|
| Invoice create | `Myynti/InvoiceFormView.swift` `save()` | yes | **yes** (no guard) | yes (`/api/invoices`) | yes, per sheet | **yes** |
| Invoice send | `Myynti/InvoiceDetailView.swift` `SendInvoiceSheet.send` | yes | **yes** | yes (`/send`, side-effect) | yes; renewed on a fresh check only when the last send did not fail | **yes** |
| Payment reminder send | `InvoiceDetailView.swift` `ReminderSheet.send` | yes | **yes** | no | no | **yes** |
| Invoice credit | `InvoiceDetailView.swift` `credit()` via `run` | yes (whole view) | **yes** | no (server refuses 2nd: `ALREADY_CREDITED`) | n/a | **yes** (error shown after success) |
| Invoice duplicate | `InvoiceDetailView.swift` `duplicate()` via `run` | yes | **yes** | no | n/a | **yes** (two drafts) |
| Invoice mark paid / sent / close / undo | `InvoiceDetailView.swift` `setStatus` via `run` | yes | **yes** | no (2nd = invalid transition) | n/a | **yes** |
| Invoice card refund / payment delete | `InvoiceDetailView.swift` via `run` | yes | **yes** | refund: yes (fixed key per payment) | refund: yes | **yes** (guard) |
| Invoice delete (draft) | `InvoiceDetailView.swift` `deleteDraft` | dialog closes, screen dismisses | no | n/a (2nd = 404) | n/a | no |
| Sales payment registration | `InvoiceDetailView.swift` `PaymentSheet.save` | yes | **yes** | yes | yes, but **rotated on every edit** (lost answer + edit = booked twice) | **yes** |
| Koti "Kohdista" (book bank row as payment) | `Koti/KotiModel.swift` `confirmMatch` | row hidden at once | no | yes | yes, one per action | no |
| Koti receipt approve | `KotiModel.approve` | row hidden at once | no | no | n/a | no |
| Koti approval sheet "Hyväksy" | `Koti/KotiApprovalSheet.swift` `save()` | yes | **yes** (unchanged form approves twice) | no | n/a | **yes** |
| Receipt approve / reject | `Kirjanpito/ReceiptDetailView.swift` `review()` | yes | no (`guard !reviewBusy`) | no | n/a | no |
| Receipt delete | `ReceiptDetailView.swift` `delete()` | dialog + dismiss | no | n/a | n/a | no |
| Receipts batch approve / delete | `Kirjanpito/ReceiptsView.swift` | yes | no (guard) | no | n/a | no |
| Email inbox approve / archive | `Kirjanpito/EmailInboxView.swift` | per row | no (`moving` set) | no | n/a | no |
| Purchase invoice save | `Kirjanpito/PurchaseInvoiceForms.swift` | yes | no (guard) | yes | yes, per sheet | no |
| Purchase invoice pay | `PurchaseInvoiceForms.swift` | yes | no (guard) | yes | yes, per sheet | no |
| Bank match confirm / unlink (receipt) | `ReceiptDetailView.swift` `confirm`/`unlink` | yes | **yes** | no | n/a | **yes** |
| Bank row confirm / reject / ignore / approve / unlink | `Kirjanpito/BankFeedView.swift` row sheet `run` | yes | **yes** | no | n/a | **yes** |
| Bank match confirm all | `BankFeedView.swift` / `StatementDetailView.swift` | yes | no (guard) | no | n/a | no |
| Period close (month done) | `Kirjanpito/PeriodsView.swift` `closeMonth` | yes | no (`guard !closing`) | `expectedLockedThrough` | n/a | no |
| Period lock / reopen | `PeriodsView.swift` `commit` | alert closes on tap | no | `expectedLockedThrough` refuses a 2nd | n/a | no |
| Customer archive / delete / restore | `Myynti/CustomersView.swift` detail `delete`/`restore` | yes | **yes** | no | n/a | **yes** |
| AI proposal accept / reject | `Chat/ChatModel.swift` `decide` | card decided at once | no (`canDecide(saving:)`) | no | n/a | no |
| Sign-out | `AppModel.logout` (`SettingsView`, `AppLock`) | dialog | no harm (local end is synchronous, revoke idempotent) | n/a | n/a | no |
| Account close / data export request | `Asetukset/PrivacyView.swift` `send` | yes | no (`guard busy == nil`) | no | n/a | no |

**27 actions audited, 12 had a gap, 12 fixed** (in 8 views; the `InvoiceDetailView` `run` fix covers credit, duplicate, status, refund and payment delete at once).

## Fix: one shared mechanism

- `LashKirjaCore/Net/SubmitGuard.swift` (pure, tested): `begin()` returns the key or nil while in
  flight; `finish(succeeded:)` keeps the key after a failure and makes a new one after a success;
  `renew()` for a genuinely new action (ignored while in flight).
- `App/Sources/Components/Components.swift` `InFlightLabel`: the button title keeps its place and a
  spinner sits on it while the request runs (no blank, no jump).
- Each gap view replaces `@State busy` with `@State submit = SubmitGuard()` and
  `private var busy: Bool { submit.inFlight }`, so existing `.disabled(busy)` /
  `interactiveDismissDisabled(busy)` keep working; the action starts with
  `guard let key = submit.begin() else { return }` and ends with
  `defer { submit.finish(succeeded: succeeded) }`.
- `PaymentSheet` no longer rotates its key when the amount/date/bank row is edited: a refused
  attempt already released the key on the server, and an attempt whose answer was lost must not be
  booked a second time with other figures (the server refuses that retry instead).
- `KotiApprovalSheet` stays in flight after success (the sheet is closing; the unchanged-form path
  approves without an await, so the guard must not reopen).

Tests: `LashKirjaCore/Tests/LashKirjaCoreTests/SubmitGuardTests.swift` — second tap ignored while in
flight, key reused after failure, new key after success, `renew` only when idle, default keys unique.

## Server changes

None. Routes without idempotency are protected by server state for a second request (credit:
`ALREADY_CREDITED`; status: invalid transition; period lock: `expectedLockedThrough`; delete: 404)
except **duplicate** and **reminder send**, which now rely on the client guard. Adding
`withIdempotency` to them is not small (both run their own transactions / send mail).

## Not changed (no gap, or out of this list)

Purchase invoice forms, customer create form and recurring forms already guard or were not in scope;
`CustomerFormSheet.save` (POST with key, no re-entry guard) is a candidate for the next pass.

## Owner device checks (Turkish list goes with the IPA)

1. Fatura oluştur: "Luo lasku"ya hızlıca iki kez dokun → tek fatura.
2. Ödeme kaydet: "Tallenna"ya iki kez dokun → tek ödeme; buton yerinde döner (spinner), ekran boşalmaz.
3. Uçak modunda ödeme kaydet → hata; uçak modunu kapat, tekrar "Tallenna" → tek ödeme.
4. Fatura gönder ve maksumuistutus gönder: çift dokunuş → tek e-posta.
5. Hyvityslasku / Kopioi / Merkitse maksetuksi: çift dokunuş → tek işlem, hata mesajı yok.
6. Koti onay sayfası "Hyväksy": çift dokunuş → tek onay.
7. Pankki satırı "Vahvista" ve kuitti eşleşme onayı: çift dokunuş → tek işlem.
8. Asiakas arkistoi / palauta: çift dokunuş → tek işlem.
