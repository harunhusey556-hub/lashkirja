# BACKLOG

Status values: `open`, `in-progress`, `done` (with a commit), `wontfix` (with a reason).

Severity:
- **P0:** a broken or missing function, or a data risk.
- **P1:** the app feels unfinished.
- **P2:** polish.

The Bar column cites the QUALITY-BAR item.

## Owner reports, 2026-09-29 (device test of IPA run 36493509156)

| ID | Sev | Bar | Report (owner's words, translated) | Status |
|---|---|---|---|---|
| OWN-01 | P1 | F1 | "While typing the password I can't see it": no show/hide toggle. | done (ecf0155) |
| OWN-02 | P1 | S1, S2 | "On e.g. the Kirjanpito page you can scroll a tiny bit, and up/down it moves very hard and minimal, it looks bad, not professional." | done (4d35743, 6f26f21; bounce needs a device check) |
| OWN-03 | P2 | T3 | "The middle button should be slightly bigger than the others." | done (4d35743) |
| OWN-04 | P0 | A1 | "When I tap 'Ota kuva' in the middle panel I expect the camera to open directly, but the app takes me to the invoice screen and makes me tap 'Ota kuva' again." | done (4d35743 + 50ad509) |
| OWN-05 | P0 | S2, S3 | "The settings tab doesn't open fully." | done (4d35743) |
| OWN-06 | P0 | A2 | "I couldn't see bank connection. Connecting a bank through Enable Banking should be put forward, and manual bank adding should be more in the background." | done in the UI (474c190); connecting needs the owner Enable Banking credentials |
| OWN-07 | P1 | N3 | "When I change page, texts disappear and come back." | done (4d35743) |
| OWN-08 | P1 | N4, A5 | "Some screens open and close abruptly without animation, e.g. the AI chat." | done (22da7fb) |
| OWN-09 | P1 | L5 | "'Rajoitettu tila' should not be shown on the AI chat page." | done (22da7fb, 97c520e) |
| OWN-10 | P1 | N2, T2, L1 | "The user experience needs to be smoother." (Covered by roadmap phase 2b, "Apple feel".) | batch 1 motion plan done; continues in batch 2 |
| OWN-11 | P1 | N4, N5, V1, A5 | The AI onboarding ("LashKirja AI: Perehdytys") needs a professional UI/UX audit. "There is not even a back button, the whole process should be like a chat, and it must be fluid." Today it is a centred modal card: no back, no earlier answers visible, emoji on every option, and steps swap abruptly. Evidence: `.superpowers/quality/batch-1/owner-screens/onboarding-*.png`. | done (eb41a06; iOS Simulator walk 36510719139) |
| OWN-12 | P0 | N4, N5, S3 | The profile sheet (avatar menu) did not open fully: "I pulled the profile menu up myself, but it still needs fixing." The sheet is not anchored to the bottom edge: a dimmed tab-bar strip shows below it. Probably the same root cause as OWN-05. Evidence: `.superpowers/quality/batch-1/owner-screens/profile-sheet-dragged-up.png`. | done (4bc5594, 4d35743) |
| OWN-13 | P1 | N3, L1 | "In the kirjanpito part the numbers come and go when changing page": the hub row values (ALV amount, Ostolaskut count, Pankkitilit, Suljetut kaudet) are fetched on every visit with no cache, so they appear blank and pop in. Evidence: `.superpowers/quality/batch-1/owner-screens/kirjanpito-hub-values-missing.png`. | done (240afe6; also swept 14 screens) |
| OWN-14 | P0 | A2 | "Bank connection doesn't work." The production server has no Enable Banking credentials: `ENABLEBANKING_APP_ID` is empty, there is no key file, and `ENABLED=false`. The UI states this honestly. It needs the owner's credentials. | done 2026-09-29: production Enable Banking app "Lashkirja v2" (401e705c), server enabled, 42 Finnish banks listed; next: the owner taps Yhdistä pankki on the phone and links S-Pankki |
| OWN-15 | P1 | S1, S2, N1 | "Interaction rules must be the same on every page: in the main menu you cannot push the page up and down, but on some pages you can. It is a small detail, but you feel restricted." Cause candidates: the `data-fit="snug"` mode makes some pages `overflow:hidden` (no bounce) while others scroll and bounce. Needs one rule for all pages, and a professional UI/UX review of consistency. | done in code (batch 2, commit 535ddf7: every screen always rubber-bands); needs the owner's device check |

## Owner reports, 2026-10-01 (device test of the latest IPA)

| ID | Sev | Bar | Report (owner's words, translated) | Status |
|---|---|---|---|---|
| OWN-16 | P1 | N2, L1 | "It doesn't feel like an app." | done in code (6c01c96, e24c112); needs the owner device check |
| OWN-17 | P1 | N3 | "The screen flashes when the page changes." | done (6c01c96): cause = slide started with the first heavy paint, tab fade dimmed the page a frame; frame probe in .superpowers/quality/batch-3/laneB |
| OWN-18 | P0 | A2 | "The bank is connected, but the home page says 'Yhdistä pankki' / no connected bank." Cause, confirmed on prod.db: an Enable Banking consent writes `ConnectedAccount` rows (1 in scope, with a balance, active S-Pankki connection), while Koti (`api/dashboard` -> `getBankOverview`, and `setup.bank`) only reads `BankAccount` (0 rows). | done (bc6a8d9, c9e95ff); deployed 12a8fe0 |
| OWN-19 | P1 | N2, N4 | "Page transition animations are not good enough for a phone app; they don't give enough feedback." | done (6c01c96): 420 ms spring push/pop after paint, tab crossfade |
| OWN-20 | P1 | T2 | "Some buttons have no background and don't give the press animation feedback." | done (6c01c96, e24c112, 12a8fe0): press state everywhere, 64 text buttons tinted; icon-only buttons untinted (ask owner) |
| OWN-21 | P1 | F | "The app needs passkey." | done in code (f38d39c, cb96a43, 4037b3c, 1c3e75b); needs APPLE_TEAM_ID + WEBAUTHN_RP_ID in prod .env, Associated Domains on the App ID and an Xcode/TestFlight-signed build (docs/PASSKEY.md) |
| OWN-22 | P2 | V | "Cool charts on the home page would look good." | done (81d3942, c9e95ff): balance trend + 6-month income/expense on Koti |
| OWN-23 | P1 | V, L1 | "Bring the front end forward in general": more visual presence and polish. | partly (charts, transitions, tinted buttons); continues next batch |

## Audit findings

(Added by the auditors in batch 1.)

## Decisions (2026-09-29)
- The AI assistant provider is GitHub Copilot (owner's choice). `COPILOT_GITHUB_TOKEN` must be set in the production `.env`; the owner supplies the token. Whatever the provider state, the UI never shows "Rajattu tila" (SHELL-11).
- iPhone is locked to portrait (SHELL-26). This is a controller ruling: landscape was never designed.
- Onboarding "Ohita nyt" snoozes for 24 h and saves no silent defaults, because the VAT profile drives ALV. This is a controller ruling.

## Batch 1 result (2026-09-29)
- Audit: 138 findings (P0 15, P1 77, P2 46) in `.superpowers/quality/batch-1/findings-*.md`.
- Closed: every P0; every P1 except those listed as deferred in the lane reports; most P2.
- Verification:
  - WebKit iPhone checks per lane.
  - 3 parallel reviews and one fix wave.
  - iOS Simulator run 36510719139 green.
  - e2e: app.spec 12/12, viewport 5/5, mobile 28/28.
  - Integration: 399/399.
- Shipped: production deploy 3b9c503, IPA run 36513524159.
- Deferred to batch 2:
  - SALES-19/21/23/24/36/38-41
  - BOOKS-24/25 (a ds decision)
  - BOOKS-19 (thumbnail)
  - SHELL-03c (detents)
  - SHELL-25 (inline boot redirect)
  - AUTH-31
  - the 309 VAT-reason field
  - review minors

## Batch 2 status (2026-09-30), pushed, NOT yet deployed or built as an IPA
- Audit: 128 findings (IA 30, VS 43, TF 29, AX 26) in `.superpowers/quality/batch-2/findings-*.md`.
- Wave A (core, done): scroll contract, rem type tokens and iOS text size, keyboard, navigation direction, gestures, pressed states, pull to refresh, a11y infrastructure.
- Wave B (stopped at a clean point on request):
  - forms: done (VS-01..07, 10, 17..23, AX-17/18/25).
  - states: done (VS-24, 30..33, TF-21 banner part).
  - a11y: done (AX-05/06/07/09/12/13/26).
  - flows: partial. Done: TF-01, 02, 03, 04, 06, 07, 11, 16.
- Not done (batch 3 / next):
  - TF-08 link the photo to the transaction, TF-09/10 capture without a form, TF-12 bank copy, TF-13 Muistuta on Myynti, TF-15 seller preflight, TF-17 (owner decision), TF-18..21, TF-24, TF-28.
  - Wave C: the Finnish glossary sweep (VS-27..29, 34..40, 12/13/25/26).
  - The ReviewQueue confirm copy is now wrong: the server refuses to approve a receipt with no amount.
  - The Kirjanpito hub subtitle is 42 characters (limit 34).
  - The money "€" suffix (R24).
  - Deferred by ruling B2-R4: TF-27, IA-12, sheet detents.
- Verification at the push: typecheck clean; unit tests 903 pass (5 known Windows failures); integration 416/416; the mobile export builds (5.84 MB). No iOS Simulator run, no IPA and no review of the batch-2 lanes yet.

## Live-use test, 2026-09-30/10-01 (status 2026-10-01, local commits, NOT pushed or deployed)
- Test: 11 journeys plus 5 gap journeys on the dev instance with real writes; 187 confirmed findings (P0 13, P1 87, P2 87), 17 P2 never independently verified, 1 disputed. Full list with causes: `docs/quality/LIVE-TEST-2026-09-30.md` (untracked, 750 KB) and `.superpowers/quality/live-test/findings.json`.
- Fixed in two waves (50 commits, base e8e914f): all 13 P0 (F04 only its manual-entry fallback), 21 of 87 P1, 9 of 87 P2, plus 54 follow-up items found by the review and the live verifiers of wave 1 (payments with a bank row, reminder wait, bank feed after file import, receipts without VAT, PDF font path in production, credit note mail, lock gaps, Raportit drill filters).
- Verified: tsc clean, unit 1132 pass (5 known Windows failures), integration 562/562, lint at baseline, live smoke 12/12 (one inferred, F07 only in desktop emulation).
- Still open: 66 P1 and 78 P2 of the live-test list. Themes: onboarding/Koti/month-close honesty (F10-F13, F20-F26), glossary and developer text (F27, F28), offline recovery (F31-F34), account and privacy (F53-F57, F18), AI assistant (F58-F60), bank connection states (G30-G35, F48, F50-F52), forms and validation (F14, F23, F37, F62-F65), send and recurring edge cases (G03-G07, G09), search and misc (F08, F09, F38-F42, F66, F70, F72).
- Owner decisions pending: OCR for receipt photos in production (Tesseract + Poppler on the PC, or a cloud/local AI image path; "Kuitti luetaan automaattisesti" copy is untrue without it), the AI "main brain" choice (local model vs cloud, privacy), reminder wait = the term the last reminder gave (7 days) instead of 24 h, an unregistered seller forces VAT 0 silently, overpayment refused, existing orphan drafts and invoices with VAT from an unregistered seller in dev data.

## Batch 3 (2026-10-01), deployed 12a8fe0, IPA run 36862695221, iOS Simulator run 36862699917 green
- Lanes: Koti bank truth + charts, shell transitions + press, passkeys, text-button sweep; one review (2 P1, 5 P2), all fixed.
- Verification: tsc clean; integration 742/742; unit 1408 pass (5 known Windows failures); mobile e2e no regressions vs baseline (12 environmental failures on both).
- Passkey removal on password change/reset/sign-out was reverted: passkeys now stay (industry norm, owner decision).
