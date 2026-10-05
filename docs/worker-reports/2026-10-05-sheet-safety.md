# P0.5 Sheet, swipe-back and destructive-flow safety (2026-10-05)

Branch `feature/sheet-safety` (from `native`). Swift does not build on Windows: verified by `iOS native` CI only.

## Shared pieces
- `Kirjanpito/DiscardGuard.swift` (existing `discardGuard`) reused for sheets: dirty -> swipe-down blocked and Peruuta asks "Hylätäänkö muutokset?"; clean -> closes at once; busy -> swipe blocked.
- New `Components/PushedDiscardGuard.swift`, `.pushedDiscardGuard(dirty:busy:asking:discard:)`: for pushed edit screens. While dirty/busy the system back button is replaced by "Takaisin" that asks the same question (hiding the system button also disables the edge swipe-back). Clean screen keeps the normal back button and gesture.
- Destructive actions already used `confirmationDialog` + `role: .destructive`; the gap was re-entrancy (busy flag set without checking it) and two actions with no confirmation.

## Audit (changes only; the other ~30 sheets already had guard/busy lock from P0.3/P0.4)
| Where | Before | Now |
|---|---|---|
| Invoice "Kirjaa maksu" sheet | Peruuta/swipe lost typed amount/note, Peruuta live while saving | discardGuard (dirty = amount changed from prefill or note), Peruuta disabled while saving |
| "Sulje perustelulla" sheet | swipe lost reason | discardGuard when reason typed |
| Customer CSV import sheet | swipe lost pasted CSV | discardGuard when CSV present, Peruuta disabled while busy; commit re-entrancy guard |
| Customer merge | merge (archives other customer) ran on one tap | confirmationDialog naming the customer, "Tätä ei voi perua"; re-entrancy guard |
| Settings > Laitteet | sign out one/all other devices ran on one tap | confirmationDialog for both, `signingOut` guard, button disabled meanwhile |
| Profile form, Password (pushed) | swipe-back/back dropped edits silently | `pushedDiscardGuard` (profile dirty = same diff `save()` sends) |
| Re-entrancy guards (`guard !busy`) | double trigger could send twice | PurchaseInvoice `run`, BankAccount `run`, Statement `perform`, recurring invoice remove, receipts delete, bank disconnect, passkey delete, mailbox disconnect |

Parent refresh: every accepted write bumps `AppModel.dataVersion` (API write hook) and lists use `.task(id: app.dataVersion)`; checked customer, recurring, purchase, statement, receipts lists. No change needed.

## Not done (left)
- ChangeEmailView (pushed; user leaves to the mail app, state kept) and Passkey create / mailbox connect password fields have no discard prompt (judged low loss).
- Send-invoice sheet message edits (rebuilt from template) still not guarded.
- Small-iPhone detent/scroll check needs a device (SE) pass.
- No pure decision logic was added, so no LashKirjaCore tests.

## Turkish device checklist
1. Fatura detayinda "Kirjaa maksu" ac, tutari degistir, asagi kaydir: "Hylätäänkö muutokset?" cikmali; hic dokunmadan kaydirinca prompt olmadan kapanmali.
2. Kaydet'e bas, yanit gelirken kaydirma/Peruuta calismamali; kayittan sonra fatura listesi/ayrinti yenilenmis olmali.
3. Asetukset > Profiili'nde bir alani degistir, sol kenardan geri kaydir: geri gitmemeli, "Takaisin" ile soru cikmali; degistirmeden geri kaydirma normal calismali.
4. Asetukset > Laitteet: bir cihaz uzerinde "Kirjaa ulos" kaydir-sil: onay penceresi cikmali; "kaikki muut laitteet" icin de.
5. Asiakas ayrintisi > Yhdista: secim sonrasi "Yhdistä tähän" onay metni diger musterinin adini gostermeli; cift dokunusta tek istek gitmeli.
6. Asiakas iceri aktar'da CSV yapistir, Peruuta: soru cikmali; iPhone SE'de sheet'ler kaydirilabiliyor mu bak.
