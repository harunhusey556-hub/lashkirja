# Worker report — first-run setup as a chat (iOS native)

Branch `feature/onboarding-chat` (from `native` @ 931db48). Owner complaint (build 72): the
"Tervetuloa" screen was a settings `Form`; it should be a chat like the web `OnboardingChat`.

## What the user sees, step by step
1. Full-screen "Tervetuloa" (inline title), a thin accent progress bar with "1 / 5" under the
   nav bar, and a quiet grey "Ohita nyt" in the toolbar.
2. Assistant bubble (sparkles avatar on `accentSoft`, `surface` bubble, radius 18):
   "Hei! Muokataan LashKirja sinun yrityksellesi sopivaksi. Se vie noin minuutin."
   then "Mikä on yritysmuotosi?".
3. Pinned at the bottom (`safeAreaInset(.bottom)`): full-width option rows with label + detail
   (Toiminimi / Yksityinen elinkeinonharjoittaja, Kevytyrittäjä / Laskutat laskutuspalvelun kautta,
   Osakeyhtiö (Oy)). One tap = selection haptic, the answer appears as a right-aligned dark
   (`ink`) bubble with a small "✎ Muuta" under it.
4. Three typing dots for ~400 ms, then the next question; the transcript auto-scrolls to the bottom.
   With Reduce Motion: no dots, no delay, no animation.
5. "Oletko arvonlisäverorekisterissä?" + hint line → "Kyllä, olen ALV-rekisterissä" /
   "En ole ALV-rekisterissä". "En" removes the VAT-period question (progress becomes "x / 4").
   "Kyllä" asks "Kuinka usein ilmoitat ALV:n OmaVerossa?" (Kuukausittain — Tavallisin, …).
6. "Mitä yrityksesi myy?" / "Mitkä ovat tavallisimmat kulusi?" (hint "Voit valita useita."):
   toggle rows with a check circle + primary button "Valmis", or "Ei mitään näistä" when nothing
   is picked (that text is then the answer bubble).
7. Summary bubble "Tässä yhteenveto. Tarkista ja vahvista." + a card of rows (Yritysmuoto,
   ALV-rekisteri Kyllä/Ei, ALV-kausi, Myynti, Kulut); each row reopens its question. Progress
   shows "Valmis". Bottom: primary "Aloita käyttö" → `POST /api/onboarding` (same `answers.body`
   payload), success haptic, `profileChanged(nil)`, `gate.completed()`. Error text in red above
   the button, error haptic.
8. "Muuta" on any answer: the transcript truncates to before that question, it is asked again
   with the earlier choice highlighted. Re-answering continues at the first question still without
   an answer — straight back to the summary if the later answers still hold (VAT yes→no drops the
   period answer; no→yes asks the period).
9. "Ohita nyt": 24 h snooze + draft as before; Koti's resume card reopens the conversation where
   it was. The draft is now also kept after each answer (like the web `saveOnboardingDraft`), so an
   app kill resumes mid-conversation. A draft in the old format (plain `OnboardingAnswers`) still
   loads: values become highlighted choices, the conversation starts from question 1.

VoiceOver: each bubble is one element; answers read "Vastauksesi: …" with hint "Muuta vastausta";
chips are buttons with the selected trait; progress is "Edistyminen, Kysymys 2 / 5"; each new
question is announced ("Kysymys 2 / 5. Oletko …"); the dots read "Kirjoittaa".
Text uses Dynamic Type styles only; rows ≥ 44–48 pt; at accessibility text sizes the choice list
scrolls (max 280 pt) so the transcript stays visible. Colours: existing `Theme` only.

## Files
- `ios-native/LashKirjaCore/Sources/LashKirjaCore/Settings/OnboardingFlow.swift` (new):
  `OnboardingStep`, `OnboardingSummaryRow`, `OnboardingFlow` (steps, current, transcript,
  progress/progressLabel, `answer(_:)` single/multi, `edit(_:)`, `isComplete`, `selection(for:)`,
  `answerText(_:)`, `summary`, `draft(from:)`). Foundation only.
- `ios-native/LashKirjaCore/Sources/LashKirjaCore/Settings/Onboarding.swift`: web questions for
  entity / VAT / VAT period with chip labels + details; `hint` now optional; `ordered` internal.
- `ios-native/App/Sources/Shell/Onboarding.swift`: `OnboardingGate.snooze(_: OnboardingFlow)`,
  new `keepDraft(_:)`, `draft() -> OnboardingFlow?`; check/resume/completed unchanged;
  `OnboardingView` rewritten as the chat.
- `ios-native/App/Sources/Onboarding/OnboardingChatParts.swift` (new): avatar, assistant/question/
  answer/typing/summary bubbles, choice row. Picked up by xcodegen (`sources: [Sources, Resources]`).
- `ios-native/LashKirjaCore/Tests/LashKirjaCoreTests/OnboardingFlowTests.swift` (new, 10 tests):
  web copy, one-question-at-a-time, VAT "no" skips the period, edit keeps still-valid later
  answers, VAT edit drops/asks the period, edit of unanswered steps ignored, answer texts +
  summary values, draft round-trip, legacy draft, tampered draft.

Not touched: Login, Koti, Chat, Theme.swift, `app/`. Koti still uses only `isSnoozed`/`resume()`.

## Not verified
- Not compiled, tests not run: this Windows machine has no Swift toolchain or Xcode
  (`which swift swiftc` → not found). CI (`.github/workflows/ios-native.yml`: `swift test`,
  `xcodegen generate` + build) must compile after the owner pushes.
- Checked by hand only: re-read all 5 Swift files; brace/paren/bracket balance 0 in each;
  no other callers of `OnboardingGate.snooze/draft` or `OnboardingQuestion.hint`.
- Not seen on a device/simulator: layout, typing animation, VoiceOver announcements, haptics.
- Deviation: the brief says "vatPeriod only when vatRegistered == true"; the model follows the web
  (`onboardingSteps`): the period stays in the list until VAT is answered "no", so progress never
  goes from 4 back to 5. The period is still only asked after "Kyllä".
