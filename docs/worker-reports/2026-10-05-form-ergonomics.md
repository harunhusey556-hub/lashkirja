# P0.4 Keyboard and form ergonomics (2026-10-05)

Branch `feature/form-ergonomics` (from `native`). Swift does not build on Windows: verified by `iOS native` CI only.

## Shared pieces (new: `App/Sources/Components/FormFields.swift`)
- `.formKeyboard()` : `scrollDismissesKeyboard(.interactively)` + a keyboard toolbar "Valmis" (number pads have no return key). Once per form.
- `.emailInput()` : emailAddress keyboard + `.emailAddress` content type, no capitals, no autocorrect.
- `.moneyInput()` : decimalPad + no autocorrect (replaces 20 bare `.keyboardType(.decimalPad)`). The pad shows a comma in the fi locale.
- `.codeInput(_)` : IBAN / BIC / Y-tunnus: no autocorrect, set capitalisation.
- `.phoneInput()` : phonePad + `.telephoneNumber`.
- Money parsing: `Money.parse` (LashKirjaCore) already handles `12,50`, `1 234,50`, `12.50`, `12,50 €` and is tested in `MoneyTests`; no new parser was needed.
- Untouched: `SubmitGuard`, `.pressable`, `ScreenLoad` usage, `AccountCodeField` (OTP logic).

## Audit
| Form | Before | Now |
|---|---|---|
| Login / SignUp / Reset (Login/*) | email type+content type, autocap/correct off, next/go flow, scroll dismiss, OTP field | already complete, unchanged |
| Invoice create/edit + lines | decimalPad, FocusState, keyboard toolbar (Seuraava/Yhteensä/Valmis), bottom bar hidden when focused, dirty guard | unchanged except decimalPad -> `.moneyInput()` |
| Customer form | no focus flow, no content types, Y-tunnus autocorrect on, phone no content type | full next-chain (name -> Y-tunnus -> contact -> email -> phone; street -> postal -> city -> notes), content types, `.formKeyboard()` (dirty guard existed) |
| Receipt editor (Receipts, Capture, Koti approval) | decimalPad, organizationName, dirty guard | `.moneyInput()`, `.formKeyboard()` |
| Purchase invoice form, payment, mark-paid | decimalPad, field errors next to fields, dirty guard | supplier organizationName, invoice number no autocorrect, `.formKeyboard()` |
| Recurring purchase / recurring invoice | IBAN caps, Y-tunnus | Y-tunnus `.codeInput(.never)`, `.formKeyboard()` |
| Bank account form / detail | IBAN/BIC no autocorrect, field errors, dirty guard; amounts use numbersAndPunctuation (needs minus) | `.formKeyboard()`, bank name capitalised |
| Payment sheets (invoice, purchase, POS, bank link) | decimalPad | `.moneyInput()`, `.formKeyboard()` |
| Settings profile / billing | phonePad, IBAN/BIC | name/org/address content types, Y-tunnus code input, phone `.phoneInput()`, `.formKeyboard()` |
| Change password | content types only | next/done focus flow, `.formKeyboard()` |
| Change email | email type | `.emailInput()` |
| Email template editor | `interactiveDismissDisabled(busy)` only: swipe lost typed text | `discardGuard` with baseline snapshot + "Hylätäänkö muutokset?" |
| EmailImport, Passkeys, Privacy, AppLock | partly typed | `.formKeyboard()` |

Keyboard covering: all forms are `Form`/`List` (system keyboard avoidance); invoice form hides its bottom bar while focused. Picker/sheet state: drafts are `@State` on the sheet owner, so opening a picker does not reset them (not changed). Validation: field errors already sit next to the field in the purchase, bank and change-email forms.

## Not done (left)
- Next/return chains for purchase invoice form, profile form, recurring purchase form (only "Valmis" and types added).
- Dirty guard for the send-invoice sheet message (draft is rebuilt cheaply, judged low loss).
- Invoice-line quantity/price keep their existing custom toolbar.

## Turkish device checklist
1. Yeni musteri formunda Nimi'de Return'e bas: sirayla Y-tunnus, yhteyshenkilo, sahkoposti, puhelin alanlarina gecmeli; puhelin/postinumero tuslugunda ustte "Valmis" cikmali.
2. Ostolasku / kuitti / maksu formunda tutar alanina `12,50` ve `1 234,50` yaz: tuslukta virgul olmali, kayit sonrasi tutar dogru gorunmeli.
3. Herhangi bir formda sayfayi kaydir: klavye surukleyerek kapanmali; "Valmis" klavyeyi kapatmali.
4. Ayarlar > Yritys: Y-tunnus, IBAN, BIC'te otomatik duzeltme/buyuk harf onerisi olmamali; e-posta degistirme alaninda e-posta klavyesi gelmeli.
5. Sahkopostimallit'te bir sey yazip asagi kaydirarak kapat: "Hylataanko muutokset?" sorusu cikmali; hic degisiklik yoksa sormadan kapanmali.
6. Salasana vaihda: Return ile alanlar arasinda gec, son alanda klavye kapansin; OTP kodu girisi eskisi gibi calismali (dokunulmadi).
