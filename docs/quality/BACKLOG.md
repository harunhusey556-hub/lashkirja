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
