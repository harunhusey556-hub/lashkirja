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
| OWN-01 | P1 | F1 | "While typing the password I can't see it": no show/hide toggle. | open |
| OWN-02 | P1 | S1, S2 | "On e.g. the Kirjanpito page you can scroll a tiny bit, and up/down it moves very hard and minimal, it looks bad, not professional." | open |
| OWN-03 | P2 | T3 | "The middle button should be slightly bigger than the others." | open |
| OWN-04 | P0 | A1 | "When I tap 'Ota kuva' in the middle panel I expect the camera to open directly, but the app takes me to the invoice screen and makes me tap 'Ota kuva' again." | open |
| OWN-05 | P0 | S2, S3 | "The settings tab doesn't open fully." | open |
| OWN-06 | P0 | A2 | "I couldn't see bank connection. Connecting a bank through Enable Banking should be put forward, and manual bank adding should be more in the background." | open |
| OWN-07 | P1 | N3 | "When I change page, texts disappear and come back." | open |
| OWN-08 | P1 | N4, A5 | "Some screens open and close abruptly without animation, e.g. the AI chat." | open |
| OWN-09 | P1 | L5 | "'Rajoitettu tila' should not be shown on the AI chat page." | open |
| OWN-10 | P1 | N2, T2, L1 | "The user experience needs to be smoother." (Covered by roadmap phase 2b, "Apple feel".) | open |
| OWN-11 | P1 | N4, N5, V1, A5 | The AI onboarding ("LashKirja AI: Perehdytys") needs a professional UI/UX audit. "There is not even a back button, the whole process should be like a chat, and it must be fluid." Today it is a centred modal card: no back, no earlier answers visible, emoji on every option, and steps swap abruptly. Evidence: `.superpowers/quality/batch-1/owner-screens/onboarding-*.png`. | open |
| OWN-12 | P0 | N4, N5, S3 | The profile sheet (avatar menu) did not open fully: "I pulled the profile menu up myself, but it still needs fixing." The sheet is not anchored to the bottom edge: a dimmed tab-bar strip shows below it. Probably the same root cause as OWN-05. Evidence: `.superpowers/quality/batch-1/owner-screens/profile-sheet-dragged-up.png`. | open |

## Audit findings

(Added by the auditors in batch 1.)

## Decisions (2026-09-29)
- The AI assistant provider is GitHub Copilot (owner's choice). `COPILOT_GITHUB_TOKEN` must be set in the production `.env`; the owner supplies the token. Whatever the provider state, the UI never shows "Rajattu tila" (SHELL-11).
- iPhone is locked to portrait (SHELL-26). This is a controller ruling: landscape was never designed.
- Onboarding "Ohita nyt" snoozes for 24 h and saves no silent defaults, because the VAT profile drives ALV. This is a controller ruling.
