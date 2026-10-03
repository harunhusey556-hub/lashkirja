# WORKER REPORT: feature/koti-first-run (Task C, Koti on a new account)

Base: `native` @ 931db48. No migration. No push or merge. iOS was **not compiled** (Windows, no Swift
toolchain). GitHub CI (`.github/workflows/ios-native.yml`) compiles and runs the tests after the owner pushes.

## Before / after, in words
**Before (build 72, a new account at 19:16):** "Hyvää päivää" was hard-coded. Below it came a bare
Käyttöönotto list with three empty circles. Then came a full green **100 % ring "Kaikki kunnossa"**
(0/0 was counted as 100 %), an ALV-ilmoitus row for August 2026 (before the account existed),
Myynti/Kulut 0,00 € cards with sparklines, and a large empty area.

**After, on a fresh account** (no receipt, statement or invoice, and no bank):
- The greeting goes by the clock: "Hyvää iltaa, Harun" at 19:16. It has no line when there is no name, as on the web.
- The onboarding resume card stays on top when it is open. Its behaviour is unchanged.
- **Aloitetaan** card:
  - Title, "Kolme askelta, niin kirjanpito pyörii itsestään.", "0/3 valmis" and a progress bar.
  - Three full-width rows. Each has an SF Symbol, a title, a one-line benefit, and a checkmark when done.
  - The next step has the single primary button (`.buttonStyle(.primary)`, 44 pt). The other open
    steps are plain rows with a chevron.
  - The routes are unchanged: receipt goes to the `CaptureFlow` cover, bank to `Route.bankAccounts`,
    seller to `Route.settings`.
- Then one outlined sentence: "Kun ensimmäiset kuitit, laskut tai pankkitapahtumat ovat sisällä, Koti
  näyttää tässä kuukauden myynnin, kulut, arvonlisäveron ja pankkitilien saldon."
- Removed on a fresh account: the status ring card (and with it the VAT row), the money cards, and
  the positions, cashflow and handled cards. Partial-failure, task and failed-jobs rows still show
  if they exist.
- A fresh account on a past month shows only the sentence, with no zero figures.

**Non-fresh accounts:** the layout is the same as before. Two changes:
1. The greeting.
2. The 0/0 ring rule: when there is nothing to count, there is no ring figure and no "Kaikki kunnossa".
   - The card shows an empty grey ring with "Ei vielä tapahtumia tässä kuussa".
   - If there are blocking items, it shows "N asiaa ennen kuun loppua" instead.

Two further changes apply to non-fresh accounts too:
- The ALV-ilmoitus row is hidden for a period whose last month is before the account's creation month.
- The ring animation respects Reduce Motion.

## Decisions
- **Step order kept (receipt, bank, seller).** The receipt takes about 30 seconds with the camera and
  shows the value at once. The bank needs a login at the bank. The seller details matter only at the
  first invoice.
- **Greeting bands follow the web code and its test exactly:** 5–9 huomenta, 10–16 päivää, 17–22 iltaa,
  23–4 **yötä**. The brief said "17–04 iltaa", but it also said "matching web exactly", and
  `koti-greeting.ts` has "Hyvää yötä".
  - Time zone: the brief asks for the local hour, so iOS uses the device time zone (web uses Helsinki).
  - Without a name there is no line (web `kotiGreeting` → null). Before, iOS showed a bare "Hyvää päivää".
  - Not ported: the web "Kuukauden viimeinen päivä…" sentence.
- **Fresh** = `setup.empty && !setup.receipts && !setup.bank`. Seller details alone keep the account fresh.
- **Known limit:** after the first receipt the account is no longer fresh, so the old Käyttöönotto list
  returns, below the money cards. This follows the brief literally: the Aloitetaan card is for fresh
  accounts only, and non-fresh accounts must look as today. Showing the Aloitetaan card until all three
  steps are done is a small follow-up if the owner wants it.
- **Server field:** the dashboard had no creation date, so I added `accountCreatedMonth` ("YYYY-MM", the
  Helsinki month of `User.createdAt`).
  - Rule: hide the VAT due when the period's last month < `accountCreatedMonth`.
  - A period the account was opened in (for example a Q3 return for an August account) still shows.
  - An older server without the field behaves as before.

## Files
- `app/src/app/api/dashboard/route.ts`: selects `createdAt` and returns `accountCreatedMonth`.
- `app/tests/integration/flows-month.test.ts`: the TF-06 test checks `accountCreatedMonth == current`.
  A new test checks that 2026-07-31T22:30Z maps to "2026-08" (the Helsinki boundary).
- `ios-native/LashKirjaCore/Sources/LashKirjaCore/Koti/KotiFirstRun.swift` (new), Foundation only:
  - `Koti.timeOfDayGreeting(hour:firstName:)`, `Koti.greeting(at:firstName:timeZone:)`
  - `Koti.isFreshAccount`
  - `Koti.SetupStep` (title, benefit, actionTitle, symbol), `Koti.SetupProgress` (done/total/next/label,
    VoiceOver labels), `Koti.setupProgress`
  - `Koti.MonthStatus` / `Koti.monthStatus(done:total:blocking:)`
  - first-run strings
- `.../Koti/KotiLayout.swift`: `Input.fresh`, `KotiSection.firstRunNote`, and the fresh-account order.
- `.../Koti/KotiTasks.swift`: `Koti.vatDue(..., accountCreatedMonth:)`. The new parameter defaults to nil.
- `.../Koti/Dashboard.swift`: `accountCreatedMonth: String?`.
- `ios-native/App/Sources/Koti/KotiView.swift`: greeting, `monthStatus` in the status card,
  `FirstRunCard`, `FirstRunNote`, and Reduce Motion in `ProgressRing`.
- `ios-native/App/Sources/Koti/KotiModel.swift`: passes `accountCreatedMonth` to `vatDue`.
- `ios-native/LashKirjaCore/Tests/LashKirjaCoreTests/KotiLayoutTests.swift`: 14 new tests (19 → 33) covering:
  - fresh detection
  - fresh layout (current month, past month, with onboarding and failures)
  - an account with a bank keeps the old order
  - setup progress, next step and VoiceOver labels
  - step wording
  - 0/0 ring and counted ring
  - greeting boundaries, clock including the screenshot's 19:16 and winter time, and the no-name case
  - VAT before account creation (monthly, quarterly, past month, field missing)
  - decoding of the new field

## Checks run (Windows)
- `cd app && npm ci`: 758 packages added.
- `npx prisma generate`: OK.
- `npx tsc --noEmit -p .`: exit 0, no output.
- `npm run lint`: 0 errors, 30 warnings, none in the touched files.
- `npx vitest run --config vitest.integration.config.ts tests/integration/flows-month.test.ts tests/integration/koti-bank-position.test.ts`:
  2 files, 26 tests passed.
- Full integration suite: 98 files, 1031 tests passed.

## Not verified
- **Swift compile and `swift test`:** not measured, because there is no toolchain here. Every touched
  Swift file was re-read by hand. Points to watch in CI:
  - switch expressions (already used in the module)
  - the `Label` generic in `stepLink`
  - `.buttonStyle(.primary)` on a `NavigationLink`
- **Running app and screenshots:** not measured, because there is no simulator here. Dynamic Type,
  VoiceOver order and the look in dark mode need a check on device.
