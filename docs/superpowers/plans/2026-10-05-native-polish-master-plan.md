# LashKirja Native — Polish, Completion and Release Master Plan

> **Primary execution plan for Cloud Workers after 2026-10-05.**
>
> Source branch: **`native`**.
> Do not use `main`, `development`, `test`, or `feature/stripe-pos` as the source of truth for new native work.
> `test` remains the WebView fallback/history branch. `main` is far behind the current native product.
>
> Product direction: **stop broad feature expansion. Finish, simplify, verify, and harden what already exists.**
>
> Tap to Pay / Stripe POS is **parked** until Apple Developer Program + Tap to Pay entitlement are available. Do not spend engineering time on production activation unless the owner explicitly unblocks it.

---

## 0. Why this plan exists

LashKirja now has a broad native SwiftUI surface: auth, onboarding, Koti, Myynti, Kirjanpito, Raportit, Asetukset, AI assistant, banking, receipts, sales/purchase invoices, recurring flows, passkeys, notifications, email import, and Stripe POS/Tap to Pay foundations.

The main risk is no longer “missing many features”. The main risk is that a large product surface can feel unfinished because of small but important interaction defects, inconsistent navigation, weak loading/error handling, device-only bugs, and incomplete release validation.

This plan therefore treats “small UX details” as first-class product correctness work.

Examples:

- OTP appears in the iOS keyboard suggestion but tapping it does not visibly fill/submit the code.
- A tap has no immediate visual/haptic feedback, so the app feels slow even when it is not.
- A sheet can be dismissed while a destructive or incomplete form is active.
- A keyboard covers a field or leaves the screen in the wrong state.
- A loading action can be triggered twice.
- A screen technically exists but its empty/error/offline states are weak.
- Navigation exposes too many nested destinations and becomes a labyrinth.

These are **not cosmetic leftovers**. They decide whether the application feels reliable.

---

## 1. Current source of truth

Worker must begin every run by reading current `native` HEAD and the following, in this order:

1. This file — `docs/superpowers/plans/2026-10-05-native-polish-master-plan.md`
2. `docs/superpowers/plans/2026-10-02-native-ios-foundation.md`
3. `docs/superpowers/plans/2026-10-02-native-ios-inventory.md`
4. Latest relevant files under `docs/worker-reports/`
5. Live source code under `ios-native/` and server routes under `app/src/app/api/`

If documentation conflicts with current code, current code + latest verified worker report wins. Update the docs when the discrepancy is understood.

### Known current native head context

At plan creation, recent native work included:

- onboarding / first-run UX
- signup and email verification
- OTP AutoFill handling
- Koti first-run flows
- account mail/security hardening
- POS/refund hardening

The last observed `native` head was `c05a341` (`fix(ios): keep the one-time-code AutoFill when it inserts the code twice; drop the paste button`).

Important: that OTP change fixed a plausible code path, but the worker report explicitly said the final iPhone AutoFill behavior was **not device-verified**. Therefore OTP is still an open **verification item**, not “fully closed”.

---

## 2. Product rule from now on

### Do

- complete existing flows
- remove confusing navigation
- improve touch feedback, loading, keyboard, sheet and error behavior
- test actual user journeys end to end
- verify native-only behavior on real iPhone where required
- improve accessibility and performance
- make failure states recoverable and understandable
- keep UI simple for a non-accountant user
- make bookkeeping automation feel quiet and trustworthy

### Do not

- add major new product areas without owner approval
- add more dashboard sections just because data exists
- add duplicate entry points to the same task
- expose backend complexity directly in the UI
- restart Tap to Pay production work while Apple entitlement is blocked
- rewrite working modules without a measured reason
- mark device-specific bugs closed based only on reasoning or Linux/Windows tests

---

# PRIORITY ORDER

## P0 — Native interaction correctness and real-device UX

This is the first workstream. Do not skip it for larger feature work.

### P0.1 OTP / verification code AutoFill — verify and finish

Owner-observed failure:

> iOS keyboard suggested the verification code. Tapping the suggestion removed/consumed the suggestion but the visible code boxes did not receive the code, so the code had to be read and typed manually.

Current code already contains a fix intended to handle iOS inserting a repeated value such as `123456123456` and to avoid duplicate submission.

#### Required work

- Re-read:
  - `ios-native/App/Sources/Login/AccountCodeField.swift`
  - `ios-native/LashKirjaCore/.../Auth/AccountCode.swift`
  - corresponding tests
  - latest OTP worker report / commit diff
- Preserve `.textContentType(.oneTimeCode)` and correct keyboard semantics.
- Verify all input paths:
  1. typing six digits manually
  2. Apple keyboard one-time-code suggestion from empty field
  3. suggestion after 1–2 digits were typed
  4. code inserted once
  5. code inserted twice in one change
  6. code inserted with separators
  7. long-press paste of a code
  8. invalid 7+ digit number
  9. wrong code → field reset → retry
  10. no duplicate network submit when SwiftUI writes a corrected value back
- Add/update deterministic unit tests for every input shape.
- **Real iPhone acceptance is mandatory** before closing the task. Capture build number + iOS version + exact observed AutoFill behavior in the worker report.
- If real device still fails, instrument the field in a temporary debug build to record the exact old/new string values received by `onChange`; fix from observed data, then remove sensitive/debug logging.

#### Acceptance

- User taps the keyboard’s verification-code suggestion once.
- Six visible boxes fill immediately.
- Verification is submitted exactly once.
- Failure shows a clear inline error and permits immediate retry.
- Manual typing and paste still work.

### P0.2 Tap feedback and perceived responsiveness

Audit all primary interactive elements in native SwiftUI:

- primary buttons
- navigation rows
- cards that are tappable
- toolbar actions
- destructive actions
- sheet actions
- segmented controls
- invoice/receipt/bank rows
- AI action cards

Rules:

- every tap must have immediate visual state change
- use appropriate iOS-native press behavior; do not create heavy custom animation systems
- meaningful actions may use light haptics through the existing `Haptics` helper
- destructive completion/error should use corresponding feedback
- disable actions while the same request is in flight
- never allow accidental double-submit of invoice/payment/delete/send operations

### P0.3 Loading / success / error / retry states

Every network-backed screen or mutation must have explicit behavior for:

- initial loading
- background refresh
- empty data
- partial data
- recoverable error
- authentication/session expiry
- offline state
- server/gateway timeout
- successful mutation

Do not replace the full screen with a spinner for small background updates.

### P0.4 Keyboard and form ergonomics

Audit native forms for:

- keyboard covering the active field
- correct `.keyboardType`
- decimal / phone / email / one-time-code semantics
- FocusState next/done flow
- dismiss keyboard on appropriate scroll/tap
- form state preserved when a picker/sheet opens
- unsaved change guard where loss would matter
- error message placed next to the field/action that caused it

Target screens include signup/login/reset, invoice create/edit, customer forms, receipt editor, purchase invoice forms, bank/manual amount inputs, settings/profile.

### P0.5 Sheet, back gesture and destructive-flow safety

- system swipe-back should work unless data loss would occur
- modal sheet hierarchy must not create double-back/double-close UI
- destructive actions need one clear confirmation, not two accidental confirmations
- incomplete forms must warn before destructive dismissal only when data would actually be lost
- sheet detents and scroll behavior must work on small iPhones

---

## P1 — Navigation and information architecture cleanup

Goal: the app should feel like four primary areas, not a tree of settings pages.

Primary tabs remain:

1. Koti
2. Myynti
3. Kirjanpito
4. Raportit

Asetukset remains secondary via profile/avatar.

### Rules

- one canonical route per task
- avoid placing the same function in multiple unrelated sections
- detail screens must return naturally to their source list
- do not create a page just to contain one button
- high-frequency actions should be reachable in 1–2 interactions
- low-frequency configuration belongs in Asetukset
- accounting terminology should not be required to find common tasks

### Mandatory audit areas

#### Kirjanpito
Keep these concepts visually distinct:

- kuitit / documents
- pankki / transactions
- ostolaskut
- ALV / periods
- work queue / exceptions

Do not make the user traverse bank account configuration to reach ordinary bank transactions.

#### Myynti
Keep sales tasks focused:

- invoices
- customers
- recurring invoices

Creation actions should be prominent; configuration should not dominate the screen.

#### Asetukset
Group by intent rather than implementation:

- Profile / company
- Billing details
- Account & login
- Security
- Email import
- Privacy
- Help

### Acceptance

Run a navigation walkthrough from fresh launch and record the number of taps required for at least:

- create invoice
- open overdue invoice
- review receipt
- open unmatched bank transaction
- connect/open bank account
- open VAT status
- change company/profile info
- open AI assistant

If a common task needs unnecessary nesting, simplify before adding anything else.

---

## P2 — Existing feature completeness pass

Do not add a new domain. Complete the existing domains.

### Auth / onboarding

- login
- signup
- email verification
- password reset
- token refresh/session expiry
- passkey sign-in and management
- onboarding skip/resume
- first-run Koti state

Each must have happy path + failure path + retry.

### Koti

Verify:

- month switching
- summary cards
- bank state
- task list
- inline approval/matching actions
- undo where supported
- first-run/empty business state
- stale/partial API state

Koti should answer: “What needs my attention today?” not become a second navigation menu.

### Myynti

Verify end-to-end:

- create/edit draft invoice
- customer quick-create
- invoice numbering/reference
- send preview and send
- PDF open/share
- payment registration/linking
- reminders
- credit invoice
- duplicate invoice
- recurring invoices
- customer edit/archive/merge where surfaced

### Kirjanpito

Verify end-to-end:

- receipt camera/photo/file capture
- upload → job polling → extracted data → save
- duplicate handling
- receipt review
- bank feed and matching
- statement upload
- bank sync/reconnect
- purchase invoice create/edit/payment
- VAT view + filing status
- period close/reopen
- work queue retry/dismiss where allowed

### Raportit

Verify:

- profit/loss date range
- loading and no-data cases
- export CSV
- accountant package/share sheet
- values match server basis; do not recompute money inconsistently in SwiftUI

### Asetukset

Verify:

- profile/company editing
- billing details
- password/email change
- sessions/devices
- PIN / biometric lock
- passkeys
- privacy requests/download
- IMAP/email import
- help

---

## P3 — Reliability and offline behavior

### Session and networking

- GET gateway 502/503/504 retry behavior remains bounded
- POST mutations are not blindly retried
- any 401 clears expired auth once and returns cleanly to login
- no login/logout loops
- stale screens do not keep privileged data after logout

### Offline

At minimum:

- clear offline banner/state
- already-loaded read views remain understandable
- receipt capture queue behaves predictably if implemented
- user is not told an action succeeded when it is only queued or failed

### Idempotency / double action

Audit all important POST actions that already support idempotency keys. SwiftUI must reuse the same key on a retry of the same user action and generate a new key for a genuinely new action.

### Error copy

Prefer human Finnish copy:

- what failed
- whether anything was saved
- what the user can do next

Do not display raw server error/code unless useful in a details/support view.

---

## P4 — AI assistant polish and trust

AI is already a feature; do not expand it into unrelated capabilities during this pass.

Focus on:

- correct markdown rendering
- readable spacing and typography
- streaming state
- stop/retry behavior
- source links open the correct in-app destination
- action cards clearly distinguish proposal vs completed action
- irreversible/destructive action requires explicit user confirmation
- assistant must not claim a bookkeeping action happened unless server confirms it
- failed tool/action states remain visible and recoverable
- conversation loading/search/archive/rename/delete should feel native and consistent

AI UI must not become another navigation labyrinth.

---

## P5 — Accessibility, performance and visual polish

### Accessibility

- Dynamic Type on core flows
- VoiceOver labels for icon-only buttons
- minimum practical hit area ~44pt
- sufficient contrast
- Reduce Motion respected
- input errors exposed accessibly

### Performance

Measure before optimizing.

Check:

- launch to usable login/home
- tab switch responsiveness
- heavy list scrolling
- image/receipt previews
- invoice form typing
- AI streaming rendering
- repeated navigation memory growth

Avoid loading every child dataset before showing the parent screen.

### Visual consistency

Keep existing native theme; fix inconsistencies rather than redesigning everything.

Audit:

- spacing rhythm
- card radius
- typography hierarchy
- destructive colors
- toolbar placement
- empty-state illustrations/text
- button hierarchy
- sheet headers
- list row separators/insets

---

## P6 — Release hardening

Before calling the native app release-ready:

### Automated gates

- `LashKirjaCore` tests green
- iOS app builds on macOS CI
- TypeScript/server build remains green for shared API changes
- relevant integration tests green
- no new lint/type errors

### Real-device matrix

At least one current iPhone must validate:

- install/launch
- login/signup/OTP
- session restore after app kill
- background → foreground
- camera/photo/file import
- PDF/QuickLook
- keyboard/form behavior
- swipe-back and sheets
- offline → online recovery
- Face ID/PIN if enabled
- passkey if configured
- bank OAuth/browser return if credentials are available

Record device model, iOS version and build number.

### Release checklist

- production API base verified
- no test secrets/tokens in repo/build
- privacy strings/capabilities accurate
- app icon/launch screen final
- version/build number correct
- crash/error observation endpoint working
- backup/restore server operational procedure documented
- accessibility pass complete
- known blocked features clearly gated

---

# PARKED — Stripe POS / Tap to Pay

Status: **BLOCKED EXTERNALLY, NOT A CURRENT ENGINEERING PRIORITY**.

Reason:

- Stripe account / integration foundations exist.
- Native POS/Tap to Pay code and server-side payment/refund logic exist and have substantial tests.
- Production activation still depends on Apple Developer Program membership, organization/account setup as required, Tap to Pay entitlement approval, signing/provisioning, and real-device validation.
- Owner does not currently want to spend the Apple Developer membership cost; no project investor is funding it now.

## Worker rule

Unless the owner explicitly says “unblock Tap to Pay / resume POS”:

- do not add new POS features
- do not redesign POS
- do not spend time on production entitlement/signing tasks
- preserve tests and avoid regressions
- keep the entry point hidden/disabled or clearly unavailable if the current build cannot use it

If touched indirectly by shared code, run the existing POS tests.

Known previous POS test evidence included `stripe-pos.test.ts` 86/86 and the integration suite 1000/1000 in the referenced worker run, but repo-external Stripe Dashboard/webhook configuration and real device activation are still separate release requirements.

---

# Worker execution protocol

## Before coding

1. `git switch native`
2. `git pull --ff-only`
3. read this plan
4. read the latest relevant worker reports
5. inspect current implementation before deciding it is missing
6. reproduce the defect or define a measurable acceptance case

Do not blindly implement an old plan checkbox if newer code already solved it.

## Task size

Prefer one coherent problem per worker branch/commit.

Good examples:

- `fix/otp-autofill-device`
- `fix/invoice-double-submit`
- `polish/bank-navigation`
- `polish/receipt-keyboard`
- `fix/session-expiry-loop`

Do not combine unrelated UI cleanup, schema migration, AI changes and bank work in one patch.

## Verification rule

Each completed task must state:

- what was wrong
- how it was reproduced
- files changed
- tests added/updated
- commands/tests run
- device verification, if needed
- what remains unverified
- screenshots/video only when they prove a visual/device behavior

“No compiler available” or “reasoning says it should work” is not sufficient to close a device-specific issue.

## Worker report

Create/update a concise report under:

`docs/worker-reports/YYYY-MM-DD-<task>.md`

Include:

- branch + base SHA
- problem
- root cause
- change
- test evidence
- device evidence
- remaining risk
- follow-up

## Integration discipline

- preserve API/server compatibility
- do not merge stale `main`/`development` into `native`
- rebase/merge only from a fresh `native` base as appropriate
- never force-update `native` casually
- keep migrations backwards-safe when possible
- do not delete history/data to make tests pass

---

# Definition of “done” for this phase

This polish phase is complete when all of the following are true:

1. Core native flows work on a real iPhone without obvious interaction defects.
2. OTP AutoFill is device-verified.
3. No common action requires confusing navigation.
4. Loading/error/empty/offline states are present for primary screens.
5. Important mutations cannot be accidentally double-submitted.
6. Auth/session expiry is clean and loop-free.
7. Camera/file/PDF/keyboard/sheet behavior is device-verified.
8. AI assistant renders correctly and clearly distinguishes suggestions from completed actions.
9. Accessibility and performance have had an explicit pass.
10. CI/build gates are green for the release candidate.
11. Tap to Pay remains safely parked until the external Apple requirement is funded and approved.

The product should feel **simple, calm, and dependable**. A user should not notice how much accounting/backend complexity exists underneath.