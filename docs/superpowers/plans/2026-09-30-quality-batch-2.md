# Quality batch 2: one interaction contract, one visual system, honest flows

**Goal:** the owner's request (2026-09-29/30): "use the same rules on every page; review the UI/UX like a professional". Deliver ONE Interaction Contract and ONE visual/content system across the whole bundled iOS app, and fix the flow defects that make Koti untrue.

**Inputs (binding; every finding has a cause with file:line and a fix sketch):**
- `.superpowers/quality/batch-2/findings-ia.md`: IA-01..30 plus the **Interaction Contract C1-C8**.
- `.superpowers/quality/batch-2/findings-vs.md`: VS-01..43 plus the **Design and content rules R1-R29**, the type scale, the status-tag table and the **Finnish glossary**.
- `.superpowers/quality/batch-2/findings-tf.md`: TF-01..29 plus the **Flow principles FP-1..16**.
- `.superpowers/quality/batch-2/findings-ax.md`: AX-01..26 plus the **Accessibility and platform rules R1-R28**.
- `docs/quality/QUALITY-BAR.md` and `BACKLOG.md` (OWN-15 is the owner's scroll observation).

## Controller rulings (2026-09-30)
- **Ruling B2-R1 (OWN-15, IA-01).** Every screen always rubber-bands. `.app-main > .app-page { min-height: calc(100% + 1px) }` with `overflow-y:auto`. The `data-fit="snug"` mode is DELETED, along with its tests. The bare pages and the chat and onboarding threads get the same 1 px range. Keep `scrollEnabled:false` and the fixed html/body. This needs a device check by the owner, because desktop WebKit has no rubber band. Cost if wrong: a slight visual bounce on short pages that the owner may not like. The value can be reverted in one CSS line.
- **Ruling B2-R2.** The glossary in findings-vs §2.10 is canonical: kuitti, kohdista, Koti, Avustaja, myöhässä, odottaa maksua, Kirjaa ulos, and so on. Retired words are removed from UI strings, and a string-lint unit test fails on them.
- **Ruling B2-R3 (type scale).** Text sizes become rem tokens (`caption`, `body` and so on) so the iOS text-size setting works (AX-01). The Capacitor `@capacitor/text-zoom` plugin maps the iOS category. Tab bar labels stay fixed.
- **Ruling B2-R4 (deferred to batch 3, on purpose).**
  - TF-27, the single Kirjanpito "Tapahtumat" list. It is a structural rebuild. Meanwhile the duplicate entry points get one vocabulary (glossary) and one connect card.
  - IA-12, the unification of detail-as-sheet versus detail-as-page.
  - IA-26 / AX-22, sheet detents.
  - AX-20 (large title collapse) only if cheap.
  - TF-17 (sign-up or invite), which needs an owner decision.
  - Dark mode. Light-only is enforced instead (AX-14).
- **Ruling B2-R5.** Anything the contract lists that needs a real finger, such as bounce, momentum and the keyboard accessory bar, is verified by the owner on the device. Everything else is verified in WebKit (with injected safe areas) and by the iOS Simulator CI run.

## Waves (lanes by file ownership; parallel rules as in batch 1)

### Wave A: lane `core` (alone; it touches many files)
Contract-level infrastructure that every other lane builds on. Scope:
- **IA-01..04, C1.** Always-bounce scroll. Delete snug. The 1 px range on `.app-main`, `.bare-frame` and the threads. Replace the S1 e2e test with an all-routes bounce assertion.
- **AX-01, B2-R3.** Type tokens in rem in `@theme`. A codemod of `text-[Npx]` to tokens across `app/src` (a mechanical sweep, so it must run before the other lanes edit those files). `@capacitor/text-zoom` (the controller pre-installs it). Layout that survives 200% (AX-02, AX-03: the sheet body always scrolls; rows stack at large sizes).
- **IA-05..07, C2.** Transition direction from the gesture source, not from URL depth. Cross-tab jumps are pushes with the origin tab kept highlighted. A drill-in never plays "no animation".
- **IA-08..11, C5/C6.** The tab bar and BottomActions hide while the keyboard is open. Form sheets lift above the keyboard. A form-level "next" handler (Enter on a `next` field moves focus and prevents submission).
- **IA-14, C4.** Collapsing inline title with a hairline.
- **IA-15..19, IA-20, C7/C8.** Pressed-state table (rows tint, buttons scale, no scale on switches, tab items 0.92), the 80 ms delayed press paint in scrollers, one `ds/Switch` (51×31, transform, haptic), the haptic map (no haptic on tab taps, a warning haptic when a destructive alert opens), and one shared gesture module (last-100 ms velocity, common thresholds).
- **IA-21, IA-22, IA-23.** Close affordance top-right; alert dialogs ignore backdrop taps; the image viewer gets pinch, double-tap and swipe-dismiss; inline disclosures animate.
- **IA-24, C1.6.** Pull-to-refresh on Koti, Myynti, Kirjanpito, Tapahtumat, Kuitit, Työt and Ostolaskut. It calls the same reload as retry.
- **IA-25.** The active-tab re-tap scrolls to the top, then pops to the root; each tab remembers its last route.
- **IA-27, IA-28.** Edge swipe exemption for the chip rows; the tab bar timing matches the push.
- **AX-04, AX-10..16, AX-21, AX-23.**
  - Per-route `document.title`; `h1` focus after navigation.
  - `inert` background under overlays; `alertdialog` for confirms.
  - Heading order fixes; the DOM order of the detail menu.
  - `prefers-contrast` and `prefers-reduced-transparency`.
  - Light-only enforced (meta, `color-scheme`, `UIUserInterfaceStyle`).
  - Toast timing (10 s with an action) and live-region roles.
  - Tab bar height 83 pt.
- **AX-08, AX-09.** Placeholder and chevron contrast, and the warning tag colours.
- **AX-07.** Values are selectable (`select-text`), and "Kopioi" is added on the detail menus.
- **Owns:** `AppShell.tsx`, `globals.css`, `ui.tsx`, `control-styles.ts`, `components/ds/**`, `BottomSheet`, `nav-direction.ts`, `navigation.ts`, `layout.tsx`, `lib/haptics.ts`, `toast`, `SelectMenu.tsx`, ios `Info.plist`, `capacitor.config.ts`, `package.json` (text-zoom only), `tests/e2e-mobile/shell.spec.ts`.
- **Also allowed, because the type codemod is mechanical:** touching any `app/src/**/*.tsx` for `text-[Npx]` replacement only.

### Wave B: four lanes in parallel, after Wave A
- **`flows` (TF, opus).**
  - TF-01/04/11: Koti tells the truth about the month. It uses `nextDueVatPeriod` and one deadline helper (FP-4). Headline equals the rows. The previous open month shows as a row. Blocking and non-blocking items are separated. The ALV row says pending receipts change the amount.
  - TF-06/15/17-note: a zero-data Koti is "Aloitetaan" with a 3-step checklist. The seller-data preflight comes before the first invoice. Onboarding collects the seller data or offers "Täydennä myöhemmin".
  - TF-02/03/08 + FP-5/6/10: safe one-tap approval. "Täydennä" when amount or vendor is missing, and the server rejects a null total. The row body opens the approval sheet from spec §3.6. "Lisää kuva" opens the camera and auto-links the photo to the transaction.
  - TF-07/13/16 + FP-13: the "Kuukauden sulkeminen" screen per month, with the checklist and the OmaVero filing steps. "Merkitse ilmoitetuksi / maksetuksi" and a filed state. The ALV drill goes to invoices.
  - TF-09/10 + FP-7/8: capture without a required form. The dirty banner only after a real edit; a save returns to the origin.
  - TF-12/18/19/20/21/24/28: bank copy for users, the export default month, the invoice subtitle, the failed-send copy, the offline copy, "Valitse tiedosto" in the "+" sheet, and the orphan settings page.
  - **Owns:** `dashboard/**`, `api/dashboard/**`, `kirjanpito/**`, `lib/alv*`, `lib/period-precheck.ts`, `ReceiptEditor.tsx`, `kuitit/kuitti/**`, `onboarding/**`, `lib/onboarding.ts`, `bank/BankSetupSheet`, `lib/bank-status.ts`, the "+" sheet items (a small hunk of `AppShell.tsx`, re-read first).
- **`forms` (VS/IA/AX, sonnet).**
  - VS-01/02/03: the sticky bar with a bottom-anchored primary and one save pattern.
  - VS-17/18/19/20/21: selects, date and month fields, the Kirjaa maksu sheet labels, a single search pattern.
  - VS-22/23: row anatomy types A/B/C, and no per-row "···".
  - VS-04/05: 320 px.
  - IA-11 wiring on the forms; AX-17.
  - **Owns:** `laskut/**`, `components/invoices/**`, `asiakkaat/**`, `toistuvat/**`, `kuitit/page.tsx` and its components, `pankki/**`, `asetukset/**`, `SellerProfileCard`, `ds/ListRow` only if the row types need it (additive).
- **`states` (VS, sonnet).** One empty, error, offline and loading pattern (VS-30..33), the `ConnectionNotice` unification, the offline overlay banner, and section heading rules (VS-24). **Owns:** `ScreenState`, `AsyncState`, `ConnectivityBanner`, `error.tsx`, `not-found.tsx`, `StaleBanner`, and the empty-state components.
- **`a11y` (AX, sonnet).** AX-05/06/11/12/13/25, the VoiceOver names on the Koti KPI links, the AI reply `role=log`, the heading levels, the label consistency, and the aria snapshots test. **Owns:** the a11y-related hunks only, coordinated through a small re-read; plus `tests/e2e-mobile/a11y.spec.ts`.

### Wave C: lane `content` (alone, last)
The mass string sweep: the glossary (B2-R2), VS-27/28/29/38/39/40 (money sign, dates, units, punctuation, button verbs, assistant naming), VS-34/35/36/37 (developer text), the status-tag table (VS-12/13/25/26), and a banned-term lint test. It runs last so that it does not collide with the feature lanes. **Owns:** all `app/src/**` string literals, `lib/status-labels.ts`, `lib/job-labels.ts`, `lib/format.ts`.

### Wave D: verification, ship
1. The iOS Simulator run (`ios-sim-check.yml`) on the batch head. It also runs the contract assertions that the harness can do (no `data-fit`, bounce range ≥ 1).
2. Three parallel reviewers, then one fix wave.
3. Deploy with `deploy-local.ps1`. The IPA is built in CI and sent to the owner with the closed IDs and the device-check list.

## Global constraints
Same as batch 1: the parallel rules in `.superpowers/sdd/2026-09-28-real-app-b-bundled/parallel-rules.md` (commit only your own paths, re-read before edit, no `npm install`, no `cap sync`, the integration and export locks, the login budget, faked non-GET). The commit trailer is:
```
Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01Kh2Zowz8EEz2jUzauogoCu
```
Verification: WebKit iPhone (390, 320, 430) with injected safe areas; typecheck, lint, unit and integration tests; and the e2e specs. Before/after screenshots go under `C:\Users\Hhusey\lashkirja-shots\batch-2\<lane>\`. Lanes report as TEXT.
