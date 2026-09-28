# Apple Feel (Roadmap Faz 2b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make LashKirja feel like a native Apple app and feel fast. That means iOS-style page transitions, consistent press and haptic feedback, layout-matched skeletons instead of spinners, optimistic actions with undo, spring sheets with drag-to-dismiss, list motion, pull-to-refresh, and a seamless launch.

**Architecture:**
- The work stays client-side, in the existing Next.js app, which ships both as the web build and as the bundled mobile static export (`npm run build:mobile`, served from `capacitor://localhost`).
- A small motion layer holds shared CSS tokens and utilities in `globals.css`, plus `lib/motion-feedback.ts` and `lib/haptics.ts`, which already exist and get extended. Shared ds components consume it, so pages mostly get the behaviour for free.
- Page transitions use the View Transitions API where available (WKWebView iOS 18+, Chrome) and fall back to an instant swap.

**Tech Stack:** Next.js 16 (read `app/node_modules/next/dist/docs/` first, including any view-transition guidance there), React 19, Tailwind v4, Capacitor 8 (`@capacitor/haptics`, `@capacitor/splash-screen` and `@capacitor/status-bar` are already installed).

**Spec:** `docs/superpowers/specs/2026-09-28-real-app-roadmap.md`, section "Faz 2b — Apple hissi".

## Global Constraints

- **Motion rules**, from `C:\Users\Hhusey\.claude\skills\design-taste\reference\motion.md`. Read it fully before writing any motion.
  - UI animations stay ≤ 300 ms. Sheet and page pushes are ≤ 350 ms with a spring-like curve.
  - Enter and exit curves: `--ease-out: cubic-bezier(0.23, 1, 0.32, 1)`. Page push: `cubic-bezier(0.32, 0.72, 0, 1)` (the iOS sheet/push feel). Never `ease-in` on UI.
  - Animate only `transform` and `opacity`. Never animate width, height, top, left, margin or padding. List height changes use the `grid-template-rows: 0fr → 1fr` technique or FLIP with transforms.
  - `prefers-reduced-motion: reduce` → no movement: an instant change, or a ≤ 150 ms opacity crossfade where it aids comprehension.
  - Keyboard-initiated actions are not animated.
  - Nothing starts from `scale(0)`: start at `scale(0.96)` plus opacity.
- **Apple motion craft:** read `C:\Users\Hhusey\.claude\skills\apple-design\SKILL.md` (and its references) before any gesture, spring, sheet or transition work. It covers springs, interruptibility, momentum and rubber-banding. Where it is more specific than the motion.md numbers, follow it, as long as the ≤ 350 ms and reduced-motion rules hold.
- **iOS conventions**, from `C:\Users\Hhusey\.claude\skills\ios-hig-design\SKILL.md`. Read the navigation, sheets and haptics parts. The haptics mapping is fixed:
  - `selection` for chip, segment and toggle changes;
  - `impactLight` for primary button presses that start work;
  - `notificationSuccess` for completed saves, approvals, payments recorded and links made;
  - `notificationWarning` for destructive confirms;
  - `notificationError` for a failed action.
  
  Haptics are no-ops on the web and when reduced motion is on is irrelevant: haptics stay on, since they are not motion.
- **No function or accessible name may change.** e2e tests depend on roles and names. Status words stay exact-text.
- **The design tokens and ds components** from phase 2 stay. Read `app/docs/appearance.md`.
- **No em dashes in UI copy.** Finnish UI copy: "Kumoa" (undo), "Päivitetään…" (refreshing), "Vedä päivittääksesi" (pull to refresh) where needed.
- **Performance:** no new dependency over 10 kB gzipped without a written reason. Motion must hold 60 fps on a mid phone. Measure with Chrome's CPU 4× throttle and record long tasks.
- **Environment:**
  - The dev server runs on http://127.0.0.1:3200 (demo@lashkirja.fi / demo123). Do not restart it or any node process you did not start.
  - Production (`C:\LashKirja\prod`, :3300, Tailscale Funnel) is NOT touched by implementers.
  - Playwright uses the installed Chrome: `require("C:/Users/Hhusey/lashkirja/app/node_modules/@playwright/test").chromium.launch({ channel: "chrome" })`.
  - Intercept every non-GET except login and logout, and never change demo data.
- **Baselines:**
  - unit tests: 5 Windows-only failures (backup-script 3, db-permissions 1, db-upgrade 1);
  - lint: 11 errors / 28 warnings. Check the current numbers first and keep them from rising.
  - Integration tests on Windows run with `NODE_OPTIONS="--require C:/Users/Hhusey/AppData/Local/Temp/claude/C--Users-Hhusey/26fedb5a-984d-4af0-ad71-2539bf3779d3/scratchpad/finalfix/npx-shell-shim.js"`.
  - `npm run build:mobile` must still succeed.
- **Every commit** ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Dt441ofXM5z9eZZdckoQC9
  ```
- **Editing:** use file tools. No git worktrees. Commit with explicit paths (`git commit -- <paths>`).

---

### Task 1: Motion foundation, press and haptic feedback

**Files:** `app/src/app/globals.css`, `app/src/lib/motion-feedback.ts` (+ test), `app/src/lib/haptics.ts`, `app/src/components/ds/*` (ActionPill, FilterChips, ListRow, BottomActions, MoreMenu), `app/src/components/ui.tsx` / `control-styles.ts` (buttons), and the call sites that save, approve, pay or link.

- [ ] Read the existing `lib/haptics.ts` and `lib/motion-feedback.ts`, and every current caller, first.
- [ ] Add motion tokens to `:root`: `--dur-press: 100ms`, `--dur-fast: 160ms`, `--dur-base: 240ms`, `--dur-push: 350ms`, `--ease-out`, `--ease-push`. Add a reduced-motion override that zeroes the movement durations.
- [ ] Press feedback is consistent everywhere:
  - every pressable (buttons, ListRow, chips, ActionPill, tab bar, header buttons) scales to `0.97` on press, with `--dur-press`;
  - rows get a background tint instead of a scale (as iOS does);
  - there are no hover-only effects.
  
  Unify the existing `active-press` / `[data-pressed]` shim rather than adding a parallel system.
- [ ] Haptics use the mapping from Global Constraints, through ONE helper, e.g. `feedback.selection()`, `feedback.success()`. Wire them:
  - FilterChips change → selection;
  - tab bar change → selection;
  - primary actions → impactLight;
  - successful save, approve, payment, link or send → success;
  - destructive confirm → warning;
  - API error surfaced → error.
  
  Use unit tests with the Capacitor plugin mocked.
- [ ] Buttons get a loading state: an inline 16px spinner that replaces the icon or sits before the label, `aria-busy`, width locked (no layout shift), and the label kept for screen readers.
- [ ] Verify (unit tests, a Playwright press check) and commit `feat(feel): motion tokens, unified press feedback and haptics`.

### Task 2: Navigation transitions and collapsing title

**Files:** `app/src/components/AppShell.tsx`, `app/src/lib/navigation.ts` (read-only use of `kind`), `app/src/app/globals.css`, and a new `app/src/lib/view-transition.ts` (+ test).

- [ ] **Direction-aware transitions:**
  - Going to a `kind: "detail"` page from its parent is a PUSH: the new page slides in from the right (`translateX(100%) → 0`) while the old one moves left by 30% and dims slightly.
  - The labelled back and the edge swipe are a POP (the reverse).
  - Tab switches are a 160 ms crossfade, with no slide.
  - Use `document.startViewTransition` with `view-transition-name` on the page container, only where supported and when not reduced-motion. Otherwise swap instantly.
  - The tab bar and header are excluded from the transition: they stay still.
  - The edge-swipe-back gesture already exists. Make it drive the pop visually if feasible; otherwise keep it and run the pop animation on release.
- [ ] **Collapsing large title (iOS):**
  - When the page's `PageTitle` h1 scrolls under the header, the header shows the same title in 17px/600, fading in over the last 24px of scroll.
  - It is driven by an IntersectionObserver or scroll-timeline, with no scroll-jank listeners.
  - The header title is `aria-hidden` (the h1 stays the one heading).
- [ ] Verify:
  - a Playwright check that the push, pop and tab crossfade run (a `document.getAnimations()` or view-transition pseudo check) and that reduced motion skips them;
  - 60 fps under 4× CPU throttle;
  - the e2e heading assertions are unchanged.
  
  Commit `feat(feel): iOS push/pop transitions and collapsing title`.

### Task 3: Skeletons and seamless loading

**Files:** a new `app/src/components/ds/Skeleton.tsx` (+ ds.test entries), the pages that show `LoadingState` / spinners for their initial load (about 16 files: `grep -rln "LoadingState\|Spinner" app/src`), and `globals.css`.

- [ ] Build the skeleton primitives, which match the real layouts pixel for pixel:
  - `SkeletonList` (ListRow rows: 36px leading tile, title line, secondary line, trailing amount);
  - `SkeletonDetailHero`;
  - `SkeletonSummaryCards` (2-column);
  - `SkeletonKeyValue`.
  
  Use a subtle shimmer: a gradient moved with `transform`, 1.4 s, paused under reduced motion. Blocks use the `line` / `canvas` tokens. Everything is `aria-hidden`, and the container carries `aria-busy="true"` plus a visually hidden "Ladataan…".
- [ ] Replace every page-level initial-load spinner with the matching skeleton. Keep small inline spinners only inside buttons.
- [ ] When cached data exists (the Task 7 persistent cache from the B plan), render it immediately. Refreshed data must replace it without layout shift: keyed rows, and no skeleton flash when a cache exists. Show a quiet "Päivitetään…" hint only if the refresh takes more than 1 s.
- [ ] The launch is seamless:
  - the splash background equals `--color-canvas`;
  - the splash hides only when the first skeleton or content is painted (`SplashScreen.hide()` after the first paint in the mobile build, with `launchAutoHide: false` set carefully and a safety timeout of 3 s);
  - the StatusBar style fits the light canvas;
  - no white flash: check `html`/`body` background and the Capacitor `backgroundColor`.
- [ ] Verify: screenshots at 390 of 5 pages mid-load (throttled), then loaded, with CLS ≈ 0 between skeleton and content (measure with a PerformanceObserver for layout-shift). Commit `feat(feel): layout-matched skeletons and seamless launch`.

### Task 4: Optimistic actions and undo toast

**Files:** a new `app/src/components/Toast.tsx` (+ test), the provider mounted in AppShell, and the action sites for payment recording, receipt↔transaction linking, approvals and archive/delete where the API supports undo.

- [ ] **Toast system:**
  - Toasts sit bottom-centred above the tab bar or BottomActions.
  - They enter with a 240 ms slide-up plus fade and leave as a fade.
  - They auto-dismiss after 4 s, pause on touch, and can be swiped down to dismiss.
  - They are announced with `role="status"`.
  - One toast is visible at a time; a new one replaces the old.
  - An optional action button, e.g. "Kumoa", has a hit area of at least 44px.
- [ ] **Optimistic UI:**
  - The listed actions update the UI immediately and fire success haptics when the server confirms.
  - On failure they roll back, show the error inside the relevant sheet or as an error toast, and fire error haptics.
  - Do NOT do anything optimistic for money-moving sends (invoice email send) or irreversible deletes: those keep their confirm sheet.
- [ ] **Undo:**
  - Where a reversible inverse API exists (e.g. unlink after link, remove payment after record), show "Kumoa" in the toast, which calls the inverse.
  - Where it does not exist, show a plain success toast. Do not invent new endpoints unless the inverse is trivial and tested (integration test with the shim).
- [ ] Verify with Playwright and every non-GET intercepted: a fake 200 shows the optimistic state and the toast; a fake 409 rolls back and shows the error. Commit `feat(feel): optimistic actions with undo toasts`.

### Task 5: Spring sheets, list motion, pull-to-refresh

**Files:** `app/src/components/BottomSheet.tsx` (+ test), `app/src/components/ds/MoreMenu.tsx`, `ListRow` list containers, the list pages (laskut, kirjanpito/ostolaskut, kuitit, pankki/tapahtumat, asiakkaat, toistuvat), and a new `app/src/components/PullToRefresh.tsx`.

- [ ] **BottomSheet:**
  - It opens with a spring-like transform (`--ease-push`, 350 ms) and the backdrop fades.
  - It supports drag-to-dismiss on the grabber and on the content when scrolled to the top: it follows the finger, and on release closes if the offset is over 30% or the velocity over 0.5 px/ms, otherwise it springs back.
  - Keep the focus trap, `overlay-root`, Escape and existing names.
- [ ] **Lists:** new rows fade and slide in 8px; removed rows collapse with grid-rows plus fade. Filter chip changes crossfade the list (160 ms). Nothing animates on the initial render.
- [ ] **Pull-to-refresh** on list roots:
  - rubber-band resistance and a spinner that rotates with the pull distance;
  - a selection haptic at the threshold (64px);
  - it triggers the page's existing reload, and the same cache-aware refresh as Task 3;
  - touch only; does not fight the edge-swipe-back or horizontal chip scroll.
- [ ] Verify: Playwright touch emulation for the sheet drag (close and spring-back) and pull-to-refresh (the reload request fires), reduced-motion paths, and 60 fps. Commit `feat(feel): spring sheets, list motion and pull-to-refresh`.

### Task 6 (controller): Final review, IPA

- [ ] One whole-plan review (opus) against this plan and the motion rules, then one fix wave.
- [ ] Push, then deploy production with `deploy-local.ps1 -Remote github -Ref feat/real-app-phase01` (the web build carries the same UI). Build the IPA with `build-ipa.yml` (`api_base_url=https://desktop-7gu8ukj.tail42feb1.ts.net:8443`), inspect it, and send it to the owner.
