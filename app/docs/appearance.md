# Appearance preferences

Dark theme, a language switch, and a separate haptic toggle are deferred until after the production reliability work. The app stays in Finnish on the light theme. Reduced motion already turns haptics off and leaves pressed state and status text in place.

## Design system (phase 2, 2026-09-28)

Every screen in the app (root, workspace, detail and settings pages) shares one visual
language, specified in full in `docs/superpowers/specs/2026-09-27-ux-restructure-design.md`
§10 and the mockups under `docs/superpowers/specs/2026-09-27-ux-restructure/`. This section
is the implementer-facing summary; the spec is binding.

### Tokens (`src/app/globals.css` `@theme`)

| Token | Value | Use |
|---|---|---|
| `--color-canvas` | `#f6f3ef` | page background |
| `--color-surface` | `#fffdfb` | cards, rows, tab bar |
| `--color-line` | `#e7e1da` | card border and row divider (1px) |
| `--color-ink` | `#26221f` | primary text, primary button background |
| `--color-ink-2` | `#6a645f` | secondary text (≥4.5:1 on `surface`) — also inactive tab-bar/sidebar labels and icons |
| `--color-accent-soft` | `#f3e6e3` | action-pill and highlight-label background |
| `--color-accent` / `--color-success` / `--color-danger` / `--color-warning` | existing values | status colors, unchanged |
| `--radius-card` | `14px` | cards and groups; pills stay fully round |

The older palette (`charcoal`, `warm-gray`, `blush`, `cream`, `rose`) is gone: the polish round
moved the last holdouts (AI assistant, app lock, empty and loading states, sheet chrome,
sidebar, error screen) to the tokens above and then deleted the old `@theme` entries, so a class
such as `text-charcoal` no longer produces any colour. Use the tokens above only.

Cards never carry a shadow; the only depth cue is the 1px `line` border. Never nest a card
inside a card. No uppercase, letter-spaced eyebrow labels — section headings are sentence
case, 13px, `text-ink-2`. No em dash (`—`) in UI copy.

### Typography

Large title 32px/700/−0.02em (`PageTitle`, `DetailHero`'s title-only mode); detail amount
40px/700 tabular (`DetailHero`); summary amount 28px/700 (`SummaryCard`); row title 15px/500;
secondary text 13px `ink-2`; chips 14px/500. Money is always formatted with `formatEur` /
`formatEurSigned` (`src/lib/format.ts`).

### Shared components (`src/components/ds/`)

`PageTitle`, `Section`, `ListRow`, `ActionPill`, `StatusTag`, `FilterChips`, `SummaryCard`,
`Card`, `DetailHero`, `KeyValueList`, `Timeline`, `BottomActions`, `MoreMenu`. Status words and
their tone colors live in one place, `src/lib/status-labels.ts` (sales invoices, purchase
invoices, receipt review, transaction/document status).

### Icons

Every icon is a [Lucide](https://lucide.dev) glyph (`lucide-react`, ISC licence) rendered through
`Icon` in `src/components/ds/Icon.tsx`; no hand-drawn inline `<svg>` for UI chrome. Sizes are fixed
per placement: `inline` 16px (chips, pills, text buttons, month/year chevrons), `row` 20px (the
36px `IconTile` of `ListRow`/sheet rows/settings rows, header circles, row chevrons), `tab` 24px
(tab bar, back chevron, the Lisää sheet's camera), `hero` 28px (the round tile of empty, error and
confirm states). Stroke is 1.75 on the 24px grid (2 at 16px). Icons are always `aria-hidden`; the
control keeps its own accessible name. Within one group, every row has a leading icon or none.
Navigation rows (hub, settings) end in a `ChevronRight` (`ListRow`'s `chevron`, `SettingsRow`);
record rows (a transaction, an invoice) do not.

The brand mark (`src/components/AppMark.tsx`, source `assets/app-icon.svg`) is a ledger book with a
ribbon bookmark and a closed-eye lash line, on the accent colour. It is the iOS app icon, the web
icons and favicon, the splash (centred on canvas), and appears in the desktop sidebar and on the
lock screen. Regenerate the PNGs from the SVG; never hand-edit them.

### Buttons and controls

Primary `bg-ink text-canvas`, secondary `bg-surface border border-line text-ink`, danger
`bg-surface text-danger border border-danger/30`, text actions `text-accent` — all
`rounded-card`, ≥48px tall, `font-semibold` (`buttonClass` / `<Button>` in
`src/components/control-styles.ts` and `src/components/ui.tsx`). Every pressable element
carries `active-press` (the `[data-pressed]` shim in `layout.tsx` paints the press); a
`hover:`-only affordance is never the sole feedback, since touch devices never see `:hover`.
`StaleBanner` and `ErrorState`'s retry actions and `ConfirmModal`'s two buttons use the shared
`<Button>` component for this reason (fixed in the phase-2 audit — they previously had
hover-only, non-`active-press` raw `<button>`s).

A control that must stay visually smaller than 44px to match the mockup (the 36px
`ActionPill`/`PageTitle`-action pill, the 32px month/year chevrons, a 28×48px switch) keeps
its visual size and grows an invisible hit area instead, with a `before:`/`after:` pseudo-
element: `before:absolute before:-inset-y-1 before:inset-x-0 before:content-['']` (one axis)
or `before:-inset-2` (both axes) sized so the tappable box reaches ≥44px. `ActionPill.tsx` has
the canonical comment explaining the math; copy its pattern rather than inventing a new one.
A short inline text link inside a sentence or a `DetailHero`/`KeyValueList` meta line (e.g.
"Asiakas" in a lasku's meta, "Raporteista" in a tietosuoja paragraph) is exempt from the
44px rule — its target is constrained by the surrounding text's line-height, the same
exception WCAG's target-size criterion makes for inline links.

### Shell

The header shows no page title: root and workspace pages carry `PageTitle`, detail pages
carry `DetailHero`; the header itself renders only the labelled back button, the assistant
button and the profile avatar. It sits on `canvas` with no border, as in the mockups. The
assistant button (`surface` circle with a line border) and the avatar (`accent-soft` circle) are a
matched pair of 36px circles, each centred in a 44px hit box, 12px apart, with their outer edge on
the same 16px line as the page content. The current tab is marked by accent colour plus a
semibold label, with no extra bar. Detail pages (`kind: "detail"` in `src/lib/navigation.ts`) hide
the tab bar and pin `BottomActions` above the safe area instead.

`BottomSheet`'s fixed overlay used to span the full viewport width, so its `inset-x-0
mx-auto` centring split the desktop sidebar's width evenly across both sides instead of
centring within the content area to its right. The `.sheet-overlay` rule in `globals.css`
starts the sheet's box at `var(--app-sidebar-width)` on desktop, so it now centres in the
visible content area next to the sidebar.

### Known exceptions (do not "fix" these)

- **Raportit's `DownloadRow`** is a real `<a>`, not `ListRow`: `ListRow`'s `href` renders
  through `next/link`, which would intercept the click and break the zip/CSV file download.
- **ReceiptPreview's fullscreen lightbox** keeps its dark chrome (not `canvas`/`surface`) —
  a full-bleed image viewer, not a content card.
- **`/kuitit`'s `BulkBar`** is a custom fixed bar, not `ds`'s `BottomActions`, because
  `BottomActions` is for detail pages only (it sits under the tab bar on tab/workspace pages).
- **`BottomSheet`'s and `ConfirmModal`'s own chrome** (`rounded-t-3xl`/`rounded-3xl` and a
  drop shadow) stays: these are floating dialog/sheet chrome, not "cards/groups" in the §10.1
  sense, and match the elevation mockups show for an overlay. `ConfirmModal`'s background and
  text now use `surface`/`ink`/`ink-2`, and both its buttons use the shared `<Button>`.
- **Toggle-switch knobs** (`BiometricUnlockCard`, the ALV switch in `asetukset/yritys`) keep a
  small `shadow-sm`/`shadow` on the round knob — the standard toggle affordance, not a card.
- **The AI assistant's chat bubbles** (`AiChatDrawer`) keep a `rounded-2xl` bubble radius
  (with the tail corner at `rounded-md`), a distinct conversational-UI convention, not a content
  card: the user's bubble is `ink` on `canvas` text, the assistant's is a `surface` bubble with a
  `line` border. The drawer itself is `canvas`, its header pairs a close circle and a menu circle,
  the composer is one rounded field with the send/stop circle inside, and every menu action's
  failure shows in the menu panel (`role="alert"`). The "match proposal" card uses
  `rounded-card`/`bg-surface`/`text-ink`.
- **`error.tsx`** now uses the same `surface` card on `canvas` as `not-found.tsx` (the old
  glass/blur shapes were removed in the polish round).

