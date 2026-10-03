# WORKER REPORT: the keyboard's one-time-code suggestion filled nothing; paste button removed (feature/otp-autofill)

Brief: `logs/task.md`. Base: `native` @ 1ce55c4. Windows worktree: no Swift toolchain, no Xcode, so
nothing here was compiled or run as Swift. GitHub CI compiles after the supervisor pushes.

## Cause

The owner's report (build 76): tapping the code suggestion above the keyboard leaves the boxes empty.

The supervisor's analysis holds when checked by reasoning and by a port of the code. iOS one-time-code
AutoFill sometimes inserts the code twice in one change ("123456123456"). `AccountCode.input` then:
1. `extract` finds no code, because a 12-digit run is "not a code".
2. It falls back to digits only, which gives 12 > 6.
3. It returns `previous` (""). The field's `onChange` writes "" back, so "nothing happens".

The same happens for "123456 123456", because `extract` reads runs `[6, 6]` as one longer number.
Reproduced with a Python port of `input`/`extract`/`inserted` (not committed): the old rule gives
`input("123456123456", previous: "") == ""` and `input("123456 123456", previous: "") == ""`.

This is the likely cause, not a proven one. What the AutoFill chip actually inserts on the owner's
phone was not observed (see "Not verified" below).

## Change

- `LashKirjaCore/.../Auth/AccountCode.swift`
  - New `repeated(_:)`: it removes the code separators (space, NBSP, dashes) and whitespace. If what
    remains is only digits and is the same 6 digits repeated two or more times, it returns those
    6 digits. Otherwise it returns nil.
  - `input` now tries these in order: `extract(inserted)`, `repeated(inserted)`, `extract(text)`,
    `repeated(text)`, then the old digits-only rule. A longer number that does not repeat
    ("123456123457", "1234567", "123456789012") still keeps `previous`, so a wrong 6 digits are never
    taken.
  - `inserted` is now `public`, because the field uses it to find what a paste added.
- `App/Sources/Login/AccountCodeField.swift`
  - The `PasteButton` ("Liitä") is gone. Also removed, because only it used them: `paste(_:)` and the
    "Leikepöydällä ei ole 6-numeroista koodia." note.
  - "Avaa sähköposti" is now the only button: full width, `OutlineButtonStyle`. Its "could not open"
    note stays.
  - A long-press paste still goes through `onChange` → `input` → `extract`, so a pasted subject or
    sentence becomes the code.
  - Pasted reset link: if what a change added contains letters and no code, it is offered to
    `onPasteOther`. If the screen takes it, the field goes back to its previous value. This is the
    path `PasswordRecoveryView` uses (link → `proof = .link`), as the paste button did before.
  - Write-back: when `kept != new`, `onChange` sets `code = kept` and returns. The write-back fires
    `onChange` again with `kept`. `input` returns its own result unchanged, so that second call is
    where completion happens, and it cannot loop.
  - New `@State settled`: the last value the field accepted. Completion fires only when the accepted
    value differs from it. Example: a code is complete and the owner types a 7th digit. The 7th digit
    is rejected, and the write-back restores the same code. Before this change, that restore called
    `onComplete` again, and sign-up sent the code again. Now it does not.
  - Typing to 6 digits, or an AutoFill write-back, still completes exactly once. When the screen
    clears the field after a wrong code (`code = ""`), `settled` resets, so retyping completes again.
  - Unchanged: the hidden field still covers the whole box row (`maxWidth: .infinity, minHeight: 56`),
    and keeps `.textContentType(.oneTimeCode)` and `.keyboardType(.numberPad)`.
- `LashKirjaCore/Tests/LashKirjaCoreTests/AccountCodeTests.swift`, two new tests:
  - `codeFieldTakesTheOneTimeCodeAutoFill`:
    - From empty: "123456123456", "123456 123456", "123456-123456" and 3× all give the code.
    - "12" + doubled code gives the code.
    - Existing "12" + autofill "123456", and "1" + "123456", give "123456".
    - "987654" + "123456" gives "123456", so the inserted code wins.
    - The write-back is stable.
    - 7+ non-repeating digits are rejected: "1234567", "123456123457", "123456 12345",
      "123456789012" after "12", and "123456a123456".
    - Typing digit by digit, and deleting.
  - `codeFieldInsertedPartIsWhatChanged`: `inserted` for an autofill, a pasted link and a deletion.
  - The existing `codeFieldKeepsTheCodeOrDigitsOnly` is unchanged.

## Checks run

- Python port of `extract`/`repeated`/`inserted`/`input`, with all new and existing `input` cases:
  `36 checks, 0 failures`. With `repeated` disabled, the port reproduces the bug (`''` for both
  doubled inputs).
- All touched Swift files were re-read for syntax and type errors.
- Swift build/tests: not measured. There is no Swift toolchain on this Windows machine; CI compiles
  and runs `LashKirjaCoreTests`.

## Not verified (needs a device)

- What the AutoFill chip inserts on the owner's phone (doubled, with a separator, or once next to
  existing text), and whether the boxes fill after this change. `input` handles all three shapes.
- The long-press "Paste" menu on the invisible field, and the link handoff to the reset screen's link
  field.
- How the full-width "Avaa sähköposti" button looks.
