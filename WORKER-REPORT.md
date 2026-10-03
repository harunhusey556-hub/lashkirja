# WORKER REPORT: account mail, iOS side (feature/account-mail-ios)

Built against `logs/account-mail-contract.md` §1 (sign-up by code) and §2 (reset by code).
Nothing under `app/` was touched.

## Files changed

| File | Change |
|---|---|
| `ios-native/LashKirjaCore/Sources/LashKirjaCore/Auth/AccountCode.swift` | NEW: request/response models, the code normaliser, the typed error enum |
| `ios-native/LashKirjaCore/Sources/LashKirjaCore/Auth/AuthService.swift` | 5 new methods |
| `ios-native/LashKirjaCore/Sources/LashKirjaCore/Models/APIError.swift` | the flat error shape now keeps `code` and `attemptsLeft` |
| `ios-native/LashKirjaCore/Tests/LashKirjaCoreTests/AccountCodeTests.swift` | NEW: 13 tests |
| `ios-native/App/Sources/Login/SignUpView.swift` | NEW: two-step sign-up sheet |
| `ios-native/App/Sources/Login/LoginView.swift` | "Luo tili" under the card (shown only when the server says it's enabled), the sign-up sheet, the after-sign-in flow pulled into `afterSignIn(_:email:password:)` |
| `ios-native/App/Sources/Login/PasswordRecoveryView.swift` | the link field also takes the 6-digit code; an email field shows when it's a code; updated copy |

The Xcode project comes from `App/project.yml` via xcodegen (`sources: [Sources, Resources]`, and no
`.pbxproj` is committed), so `SignUpView.swift` gets picked up without any other change.

## New public API (LashKirjaCore)

- `AuthService.signupStatus() async throws -> SignUpStatus`: `GET /api/auth/signup/status`
- `AuthService.signupStart(email:password:firstName:) async throws -> SignUpStartResponse`: `POST /api/auth/signup/start`
- `AuthService.signupVerify(email:code:) async throws -> AuthUser`: `POST /api/auth/signup/verify`. It decodes `TokenResponse` and calls the same private `start(_:)` as `login`, so the token is stored exactly as a password sign-in stores it (including the KEYCHAIN failure path).
- `AuthService.signupResend(email:) async throws`: `POST /api/auth/signup/resend`
- `AuthService.resetWithCode(email:code:password:) async throws`: `POST /api/auth/password/reset` with `{ email, code, password }`
- Models: `SignUpStatus { enabled }` (a missing or invalid flag decodes as `false`, so it fails closed), `SignUpStartBody { email, password, firstName }`, `SignUpStartResponse { ok?, mailConfigured? }`, `SignUpVerifyBody { email, code, device = "ios-app" }`, `SignUpResendBody { email }`, `ResetWithCodeBody { email, code, password }`. Addresses are trimmed and lowercased like `login`, and codes are normalised.
- `AccountCode.normalize(_:) -> String?`: strips whitespace, dashes (`-‐‑‒–—`) and a `LashKirja-vahvistuskoodi:` prefix (case-insensitive, even with text before it such as "Re: "). It returns the code only if exactly 6 ASCII digits are left. Also `AccountCode.length`, `.subjectPrefix`, `.resendSeconds = 60`, `.address(_:)`.
- `AccountCodeFailure` (built with `AccountCodeFailure(_ error: LKError)`), `.message(serverMessage:)` and `.startsOver`.

## How each contract error is mapped

`APIErrorDecoder` used to drop everything except `error` from the flat `{ error: "..." }` shape. It
now also keeps a string `code` (→ `LKError.code`) and a numeric `attemptsLeft` (→
`LKError.fields["attemptsLeft"]`). It also accepts a body that has only `code` and no `error`
(`409 { code: "SIGNUP_EMAIL_TAKEN" }`); the message then falls back to `LKError.unreachable`. A `code`
of an unexpected type is ignored and the `error` sentence is kept. The nested shape works as before.

| Server answer | `AccountCodeFailure` | Shown (Finnish) |
|---|---|---|
| 400 `SIGNUP_CODE_INVALID`, `attemptsLeft` | `.codeInvalid(attemptsLeft:)` | "Koodi ei kelpaa. Yrityksiä jäljellä: N." / "… Yksi yritys jäljellä." |
| 400 `RESET_CODE_INVALID` | `.codeInvalid(attemptsLeft:)` | same |
| 410 `SIGNUP_EXPIRED` | `.signUpExpired` (`startsOver`) | "Koodi on vanhentunut tai sitä yritettiin liian monta kertaa. Aloita tilin luonti uudelleen." The sheet goes back to step 1. |
| 410 `RESET_EXPIRED` | `.resetExpired` | "… Pyydä uusi palautusviesti." |
| 409 `SIGNUP_EMAIL_TAKEN` | `.emailTaken` (`startsOver`) | "Tällä sähköpostiosoitteella on jo tili. Kirjaudu sisään tai palauta salasana." |
| 403 `SIGNUP_DISABLED` | `.disabled` | the server's sentence (fallback: "Uusien tilien luonti ei ole käytössä.") |
| 429 (any body) | `.rateLimited` | the server's sentence (fallback: "Liian monta yritystä. …") |
| 503 on start (mail not configured), offline, anything else | `.other` | the server's sentence or `LKError.unreachable` |

`signupStatus` failing for any reason (offline, an older server without the route) keeps "Luo tili" hidden.

## App behaviour

- **LoginView**: below the sign-in card it shows "Eikö sinulla ole tiliä? **Luo tili**" as a text button (not a second primary), only when `signupStatus().enabled == true`. When sign-up succeeds, the sheet closes and the same `afterSignIn` as the password login runs: the passkey offer once, otherwise `app.enter(user)`.
- **SignUpView**: step 1 has first name, email and password. The password is checked with `PasswordReset.validate`, so the minimum is `PasswordReset.minLength` (8). The primary button is "Lähetä koodi". Step 2 has a `.oneTimeCode` + `.numberPad` field, the copy "Syötä sähköpostiin lähetetty 6-numeroinen koodi …" and the primary button "Vahvista ja luo tili". The code is sent automatically once the field holds 6 digits (the keyboard's autofill). There is also "Lähetä koodi uudelleen (N s)" with a 60 s countdown (`TimelineView`), "Vaihda sähköpostiosoite", and the attempts-left message in the failure section.
- **PasswordRecoveryView**: the reset step's header is now "Palautuslinkki tai koodi" and its footer "Liitä linkki tai syötä 6-numeroinen koodi sähköpostista. …". Six digits after normalising go to `resetWithCode`, with an extra "Tilin sähköposti" field that is prefilled from the login field. Anything else goes down the existing token path unchanged. Copy on the request step now mentions "linkin ja koodin".

## Not verified (no Swift toolchain or Xcode on this Windows machine)

- **Nothing was compiled or run.** `command -v swift swiftc` finds nothing. Neither `swift test` (Linux CI) nor `xcodebuild test` (macOS CI) has run, so the 13 new tests and the existing suite are **not measured**. The first push to CI will show the result.
- What I did check by hand: I re-read every changed file for syntax and types, ran a script that counts brackets (balanced; the only mismatches it reported came from how the script matches strings, and I checked those lines by eye), and confirmed that the Core files use only Foundation.
- Points most likely to need a fix if CI fails:
  1. `("0"..."9").contains(Character)` and `kept.unicodeScalars.append(contentsOf:)` in `AccountCode.normalize`.
  2. Switch expressions with `where` clauses in `AccountCodeFailure.message`.
  3. In LoginView, the second `.sheet(isPresented:)` next to `.sheet(item:)`, and the `Task` that sets `busy` inside the sheet callback.
  4. `TimelineView` inside a `Form` `Section` in SignUpView.
- Not checked against a live server: whether the 503 from `signup/start` carries the `x-lashkirja-api-version` header. It makes no difference for a POST, which is never retried.
- The UI has not been seen running (no simulator).

## Side effect worth knowing

Three existing server routes already send the flat `{ error, code }` shape: `invoices/[id]/payments`
409, `statements` 422 and `lib/pos-route.ts`. Their `LKError.code` is now filled where it used to be
`nil`. No app code or test compares those errors by `code`, and no test fixture uses a flat error with
a `code`, so nothing should change. Still, a flat 401 carrying `code: "UNAUTHORIZED"` would now end
the session through `LKError.endsSession`. As of this commit the server sends that code only in the
nested shape, so it doesn't happen today.

## Contract changes

None. Assumptions the contract leaves open:
- `signup/verify` sends `device: "ios-app"`, the same value `login` sends.
- `signup/resend` and the code-path `password/reset` are read as `Ignored` (any 2xx body).
- 429 is mapped by status whatever its body contains.
