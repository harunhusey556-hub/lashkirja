# QUALITY BAR: what "done" means for every LashKirja screen

LashKirja must feel like a native iOS app: clean, calm, fast and predictable. Each item below is pass/fail. Auditors cite the item ID (e.g. `F3`) in every BACKLOG entry.

## F: Forms and input
- F1: Password fields have a show/hide toggle (an eye icon with a ≥44px target, `aria-label` "Näytä salasana"/"Piilota salasana", keeps focus and caret).
- F2: The right keyboard for every field: `inputmode`/`type` (email, numeric/decimal for money, tel, url), `autocomplete`, `autocapitalize`, `enterkeyhint`; iOS Password AutoFill works on login and on password change.
- F3: Labels always visible (never placeholder-only); errors are inline under the field, `role="alert"`, and never only at the top of the page.
- F4: Submit buttons show pending state inside the button, keep their width, and block double submit. Success is visibly confirmed (toast, haptic, or navigation).
- F5: The keyboard never covers the focused field or the primary button. Tapping outside or scrolling dismisses the keyboard where iOS would.
- F6: Money input accepts Finnish formats (`12,50`, `12.50`, `1 234,50`) and shows `€` consistently.
- F7: Unsaved changes are guarded when leaving a form.

## S: Scrolling and layout
- S1: A page whose content fits the screen does NOT scroll at all. There is no 1–20 px "jitter" scroll.
- S2: A page that scrolls uses one scroll container with native momentum; the header and tab bar never move with it; overscroll does not reveal blank areas or move fixed chrome.
- S3: Safe areas are respected (notch/Dynamic Island, home indicator) in every orientation the app allows, and nothing is hidden behind the tab bar or bottom actions.
- S4: No horizontal page scroll anywhere at 320–430 px width.
- S5: Long lists keep 60 fps and do not jank during scroll.

## N: Navigation and transitions
- N1: Every function has one home, reachable in ≤2 taps from its tab.
- N2: Push/pop transitions between a list and its detail: the new page slides in over the old one, which shifts left ~30 % and dims (pop is the reverse), on a critically damped spring of 350–450 ms that starts on the frame after the new page is painted (no skipped start, no jump-cut). Tab switches never slide: a ≤200 ms crossfade of the old page over the new one, never a dimmed or blank frame. Reduced motion turns all of them into that crossfade.
- N3: No text or content flicker on navigation: the previous content stays until the next is ready, and cached content renders on first paint.
- N4: Every sheet, drawer, modal and menu opens and closes with motion (sheet: slide up with a spring-like curve; drawer: slide; fade the backdrop). Nothing pops in or out abruptly.
- N5: Sheets can be dismissed by swiping down and by tapping the backdrop, unless there are unsaved changes.
- N6: Back returns to exactly the previous scroll position and filter state.
- N7: The back label names the screen you came from (SHELL-31). It names the logical parent only when there is no previous screen (a cold start or a deep link) or that screen has no fixed name (a record detail page).

## T: Touch and feedback
- T1: Every pressable element has a pressed state (`active-press`) and a ≥44×44 px hit area.
- T2: Haptics (native only): selection on chips/toggles, light impact on primary actions, success on save/approve/pay, error on failure.
- T3: The centre "+" is visually the primary control (slightly larger than the other tab items).
- T4: Destructive actions confirm, or offer undo ("Kumoa") when reversible.

## L: Loading, empty, error, offline
- L1: First load shows a skeleton that matches the final layout, not a spinner in empty space.
- L2: Every list has a designed empty state with one next action.
- L3: Every failure shows a human Finnish message plus a retry, placed where the action happened.
- L4: Offline and server-unreachable states are clear and never hang.
- L6: One empty pattern: a 56 px tile, "Ei X vielä" (17/600), one 15 px sentence, at most one primary with the same label as the header pill. No search, filters or zero tables over an empty screen. An empty section inside a populated screen is one line in a card, "Ei X vielä." (`EmptyNote`).
- L7: One error pattern: the `ConnectionNotice` card in the place of the content, titled "Jotain meni pieleen", with ONE "Yritä uudelleen". Never a card inside a card, never a second retry, never swallowed into a row subtitle. Outside the shell: `FullScreenNotice`.
- L8: One offline pattern: an overlay banner "Ei verkkoyhteyttä. Näytetään viimeksi haetut tiedot." that never moves the content. While a page card (`ConnectionNotice`, `StaleBanner`) owns the message, the banner stays quiet. A banner that claims saved data is never shown over an empty error card.
- L9: One loading pattern: a `ds/Skeleton` at the final layout; no blank card and no "Ladataan…" line. Spinners live only inside a button or an image. The avatar tile never swaps a glyph for the initial.
- L5: No developer or internal text is visible to the user: no "Rajoitettu tila", debug labels, raw error codes, or English strings.

## A: App features (native)
- A1: "Ota kuva" opens the camera directly (Capacitor Camera), then continues into receipt review with the photo; there is no intermediate screen that asks again.
- A2: Bank connection: Enable Banking "Yhdistä pankki" is the primary, prominent path wherever bank accounts appear. Manual account entry is secondary. If Enable Banking is not configured on the server, the UI says what is missing instead of hiding the option.
- A3: Share, download and open-in use the native share sheet.
- A4: Status bar style and colour match the screen.
- A5: The AI assistant opens and closes with motion, keeps its thread, shows streaming or progress, and never shows internal mode labels.

## V: Visual consistency
- V1: Tokens only (canvas/surface/line/ink/ink-2/accent), one radius system, no shadows on cards, Lucide icons at the standard sizes.
- V2: Typography follows the approved scale; no truncation of important labels at 320 px.
- V3: Every screen matches the approved mockup language (`docs/superpowers/specs/2026-09-27-ux-restructure/*.png`).

## P: Performance (bundled app on a mid-range iPhone)
- P1: Cold start to first meaningful screen ≤ 1.0 s from the bundle, with cached data.
- P2: Tab switch ≤ 150 ms to painted content (from cache).
- P3: Interaction to visual response ≤ 100 ms (INP).
