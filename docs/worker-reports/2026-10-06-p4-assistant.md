# P4 assistant polish and trust (2026-10-06)

Branch `feature/p4-assistant` from `origin/integration`. Swift cannot build on Windows; verification is the `iOS native` CI run on the pushed branch.

## Per item

| Item | State |
|---|---|
| Markdown answers | New. `ChatMarkdown` (core) splits a reply into paragraphs, headings, bullet and numbered lists; inline bold/italic/code/links via `AttributedString`. Drawn by `ChatMarkdownText`. No web view. Before, only inline markdown was drawn and list lines showed as raw "- ". |
| Progressive streaming | Already held (60 ms batched flush). Now markdown renders while streaming too; a half-written marker shows as plain text. |
| Stop button | Already held (send button turns into Pysäytä). |
| Retry | New. `ChatTurn` state machine (core) and `ChatModel.retry()`. A failed answer shows the reason and "Yritä uudelleen"; it re-sends the same text with the same `clientId`, the user bubble is not duplicated, a partial reply is replaced. Stop is not a failure. |
| Links open native screens | Already held (`ChatInlineLink`, `Route.fromHref`, destination cards, `AppLink` already has receipt and bank-row targets). No change. |
| Suggestion vs done | Fixed. While a decision is saving, the card read "Kohdistus hyväksytty" in green; now it reads "Tallennetaan…" (neutral) until the server confirms. Cards already carry titles "Ehdotus kohdistukseksi", "Laskuluonnos", "Kuitin korjaus". |
| AI unavailable | Already held: `/api/ai/status` drives an intro and a composer note ("Tekoälyavustaja ei ole juuri nyt käytössä. Pikakomennot toimivat silti."), shortcuts and typing stay usable. No change. |
| Server | No change. The server reuses a user message that has the same `clientId`, so a retry does not duplicate it server-side. |

## Tests
`ChatMarkdownTests.swift` (new), `ChatFeaturesTests.swift` (saving label updated).

## Simulator checks (demo server without an AI provider)
- Chat opens, shows the unavailable note and the three shortcuts.
- Kill the server mid-question: failure line plus "Yritä uudelleen"; tap it after restart, only one user bubble.
- Shortcut answers (help/bank/ALV) with lists render as bullets, not "- ".
