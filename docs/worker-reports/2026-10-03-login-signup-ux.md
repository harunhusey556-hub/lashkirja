# WORKER REPORT: login + sign-up screens, and the emailed code that would not paste (feature/login-signup-ux)

Brief: `logs/task.md` (TASK A). Base: `native` @ 931db48.

## The paste bug: cause and fix

Cause (as the supervisor found it): the code field only auto-submitted when `AccountCode.normalize`
saw exactly 6 digits in the whole input. Gmail copies the subject or a body line
("LashKirja-tilisi vahvistuskoodi on 123456. Koodi on voimassa 15 minuuttia."), and the extra "15" made
the input fail. The number pad also has no paste key, and the keyboard's "From Mail" suggestion only
reads Apple Mail.

Fix:
- `AccountCode.extract(_:)` (LashKirjaCore) returns the first standalone 6 ASCII digits, allowing one
  space or dash in the middle (3 + 3). A 7+ digit number, digits inside a word or a link token
  (`=`, `/`, `_`, `-` next to them), `123456.78` or `040 123 4567` never count as a code.
  `normalize` stays as it was for the exact case.
- `AccountCode.input(_:previous:)` is what the field keeps after each change. If the text just typed or
  pasted contains a code (or the whole field does), it keeps only those 6 digits. Otherwise it keeps
  only the digits, at most 6. A 7th digit, or a pasted long number, leaves the previous value, so a
  wrong 6 digits are never auto-submitted. Pasting a code after digits already typed keeps the pasted
  code, not the first six digits.
- `AccountCodeField` (new, shared by sign-up and reset) draws 6 boxes over one hidden `TextField`
  (`.oneTimeCode`, number pad). Typing, the keyboard suggestion and a long-press paste all go into that
  one field. When the code is complete it calls `onComplete` once. Sign-up then verifies, and the
  existing `guard !busy` stops a double submit. Below the boxes:
  - `PasteButton(payloadType: String.self)` (no "Allow Paste" prompt) runs the text through `extract`.
    If nothing is found it shows "Leikepöydällä ei ole 6-numeroista koodia."
  - "Avaa sähköposti" opens `googlegmail://` if `canOpenURL` says Gmail is installed, otherwise
    `message://`. If opening fails, it says so in text.
- `App/project.yml`: `LSApplicationQueriesSchemes: [googlegmail]` under the app target's Info.plist
  properties (xcodegen; no pbxproj touched).
- Server mail (`app/`):
  - Sign-up subject: `123456 on LashKirja-vahvistuskoodisi`. The body starts with the code alone on
    its own line, then one sentence ("…voimassa 15 minuuttia."), then the existing "ignore" line.
  - Reset subject: `123456 on LashKirjan salasanan palautuskoodisi`. The body starts with the code
    alone on its own line, then one sentence, then the link (kept), then the existing "ignore" line.
  - Old subjects (`LashKirja-vahvistuskoodi: 123456`) still work with `normalize` and with `extract`.

## Before / after per screen

**Login (`LoginView`)**
- Before: a big shadowed 60pt logo tile and a large title. Placeholder-only fields inside a card. The
  "Kirjaudu sisään" button sat in the scroll content, where the keyboard could hide it. "Luo tili" was a
  small text link that opened a half sheet. "Unohditko salasanan?" also opened a sheet.
- After:
  - Header: a small brand row (accent `book.closed.fill` + "LashKirja"), then a large-title
    "Kirjaudu sisään" (header trait) and the one-line tagline.
  - Each field has its label above it (`AuthField`) and a 52pt box. The address is checked when the
    owner leaves the field and again on submit. A typo shows as text with an icon under the field,
    not just a red border. Next/Go keyboard flow is kept, and the eye toggle has a 44pt target and a
    VoiceOver label.
  - "Kirjaudu sisään" is pinned in a bottom bar via `.safeAreaInset(edge: .bottom)`, so it rides above
    the keyboard. While busy it shows a spinner and "Kirjaudutaan…" inside the button.
  - With passkeys offered, the passkey button stays the only primary and the password button is
    outlined (same as before).
  - "Luo tili" is a full-width 52pt outline button under the form (only when `signupStatus().enabled`).
    It pushes the sign-up screen in a `NavigationStack`.
  - Password recovery is now pushed too, not shown as a sheet. The reset deep link
    (`pendingResetLink`) pushes it the same way.
  - The passkey offer after sign-in works as before.

**Sign-up (`SignUpView`)**
- Before: a sheet with a `Form`. The steps were not labelled. The code was a single `TextField` that
  stayed empty or full of junk after a Gmail paste.
- After: a pushed full screen with "Vaihe 1/2" or "2/2", the step name and a thin `ProgressView` bar.
  - Step 1, "Tilin tiedot": labelled fields for first name, email and password.
    - Each field's problem shows under that field.
    - The password has a show/hide toggle and `.newPassword`, so iOS can suggest a strong password.
    - A live tick for "Vähintään 8 merkkiä" (`PasswordReset.minLength`, the server's only rule).
    - The primary "Lähetä koodi" is pinned at the bottom.
  - Step 2, "Vahvista sähköposti":
    - "Lähetimme koodin osoitteeseen <email>", then the 6 boxes (focus ring on the active box;
      tapping the boxes focuses the field), "Liitä" + "Avaa sähköposti".
    - Server errors show next to the code, using the existing `AccountCodeFailure` messages
      (attempts left / expired / taken). Expired or taken goes back to step 1.
    - Resend with the 60 s countdown, and "Vaihda sähköpostiosoite". The back button on step 2 returns
      to step 1, and is hidden while busy.
    - Primary "Vahvista ja luo tili" is pinned at the bottom (it is there if auto-submit could not run).
    - On success: haptic, then the existing `onSignedIn` → `afterSignIn` path.
  - The step change animates only when Reduce Motion is off.
- API contract and `AuthService` methods unchanged (`signupStart`, `signupVerify(email:code:password:)`,
  `signupResend`, `resetWithCode`).

**Password reset (`PasswordRecoveryView`, reset step)**
- Before: one free-text "Linkki tai koodi" field, plus a `UIPasteboard` button (which triggers the paste
  prompt).
- After: a segmented "Koodi | Linkki" control.
  - Code mode: account email + the same `AccountCodeField`. A link pasted with "Liitä" switches to link
    mode, and a code typed into the link field switches back.
  - Link mode: a link field + `PasteButton`.
  - New password fields are labelled, and their errors show under them. "Tallenna salasana" is pinned
    at the bottom.
  - The request step and the done screen stay as before (a `Form`), but are now pushed, without a
    "Sulje" button.

## Files

| File | Change |
|---|---|
| `ios-native/LashKirjaCore/Sources/LashKirjaCore/Auth/AccountCode.swift` | `extract`, `input(_:previous:)`, `EmailCheck.problem` |
| `ios-native/LashKirjaCore/Tests/LashKirjaCoreTests/AccountCodeTests.swift` | 5 new tests (extract ×3, input, email check) |
| `ios-native/App/Sources/Login/AccountCodeField.swift` | NEW: 6-box code input, Liitä, Avaa sähköposti |
| `ios-native/App/Sources/Login/AuthFormParts.swift` | NEW: `AuthField`, `ShowPasswordButton`, `AuthButtonLabel`, `OutlineButtonStyle` (moved from LoginView), `AuthBottomBar` |
| `ios-native/App/Sources/Login/LoginView.swift` | redesign, `NavigationStack` with pushes |
| `ios-native/App/Sources/Login/SignUpView.swift` | 2-step pushed screen |
| `ios-native/App/Sources/Login/PasswordRecoveryView.swift` | pushed; reset step uses `AccountCodeField` |
| `ios-native/App/project.yml` | `LSApplicationQueriesSchemes: [googlegmail]` |
| `app/src/lib/signup.ts` | `signupCodeMail` subject/body |
| `app/src/app/api/auth/password/forgot/route.ts` | reset mail subject/body |
| `app/tests/integration/account-mail.test.ts` | asserts the new subjects and the code-alone first line (sign-up and reset) |

## Checks run (real output)

- `npm ci`: ok. `npx prisma generate`: "Generated Prisma Client (7.9.1)".
- `npx tsc --noEmit -p .`: exit 0.
- `npm run lint`: "✖ 30 problems (0 errors, 30 warnings)", exit 0. None of the warnings are in files
  touched here.
- `npx vitest run --config vitest.integration.config.ts tests/integration/account-mail.test.ts`:
  "Test Files 1 passed (1) / Tests 30 passed (30)".
- Also run, because they call the forgot route: `tests/integration/review-remainder.test.ts` and
  `tests/integration/wave-i-account.test.ts`: "Test Files 2 passed (2) / Tests 13 passed (13)".
- Swift logic cross-check (not a compile): a line-by-line Python port of `extract` / `input` /
  `inserted` (`logs/port_check.py`, not committed) ran every `extract` and `input` expectation from
  the new Swift tests, plus the full new reset mail: "cases: 44 failures: []".

## What could not be verified here

- **No Swift toolchain or Xcode on this Windows machine** (`which swift swiftc xcodebuild` finds nothing).
  Neither `swift test` for LashKirjaCore nor `xcodebuild` for the app was run. GitHub CI
  (`ios-native.yml`) compiles both after the owner pushes. The Swift files were re-read by hand for:
  - Result-builder bodies, `if` inside `.toolbar`, and the memberwise inits of `AuthField` /
    `AccountCodeField`, with trailing-closure matching.
  - `FocusState<Bool>.Binding` passing and the `@State` mutations inside closures.
  - Ternaries with interpolated strings (made explicit `String`s to avoid `LocalizedStringKey`
    ambiguity).
  - API availability against iOS 18: `PasteButton` iOS 16, `onChange(of:){old,new}` iOS 17,
    `navigationDestination(item:)` iOS 17, `TextField(…, axis:)` iOS 16.
  - Core staying Foundation-only.
- Not run on a device or simulator, so none of these were seen working:
  - Long-press paste on the hidden field.
  - The `PasteButton` look.
  - Opening Gmail.
  - Keyboard avoidance of the bottom bar.
  - VoiceOver order.
- `PasteButton`'s title is drawn by the system and cannot be set to "Liitä koodi". It shows "Liitä"
  only if iOS uses Finnish for the app. The app has no `fi` localisation or `CFBundleDevelopmentRegion`,
  so it will probably show "Paste". Follow-up outside this brief's ownership: set
  `CFBundleDevelopmentRegion: fi` in `project.yml`.
- The reset-mail subject now also shows the code on the lock screen (same pattern as sign-up, as the
  brief asked). The code is useless without the account's address and is limited by the existing guard.
