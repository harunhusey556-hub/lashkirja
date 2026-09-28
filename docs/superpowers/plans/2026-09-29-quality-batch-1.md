# Quality batch 1: implementation plan (lanes)

> Execution: parallel lanes, as described in docs/quality/SYSTEM.md. Every lane follows `.superpowers/sdd/2026-09-28-real-app-b-bundled/parallel-rules.md` (commit only your own paths with `git commit -- <paths>`, never run `npx cap sync` on Windows, observe the login rate limit, take the integration-test lock).

**Goal:** close every P0 and P1 finding, and every owner report OWN-01..12, from the batch-1 audit, so that the bundled iOS app meets `docs/quality/QUALITY-BAR.md` on the items touched.

**Inputs** (binding; each finding has a cause with file:line and a fix sketch):
- `.superpowers/quality/batch-1/findings-auth.md` (AUTH-01..31)
- `.superpowers/quality/batch-1/findings-sales.md` (SALES-01..42)
- `.superpowers/quality/batch-1/findings-shell.md` (SHELL-01..34, including the onboarding design and the motion plan)
- `.superpowers/quality/batch-1/findings-books.md` (BOOKS-01..31, including the bank design and the scroll table)
- `docs/quality/BACKLOG.md` (OWN items and decisions)

**Scope:**
- All P0 and P1 items.
- P2 items when they sit in a file the lane already touches and cost under about 15 minutes.
- Any other P2 goes to the "Deferred" list in the lane report, with a reason.

## Global constraints
- The fix sketch in the findings is the default. Deviate only with a stated reason in the report.
- Motion tokens are defined once in `globals.css` `@theme`:
  - `--ease-out: cubic-bezier(0.23,1,0.32,1)`
  - `--ease-in-out: cubic-bezier(0.77,0,0.175,1)`
  - `--ease-drawer: cubic-bezier(0.32,0.72,0,1)`
  - `--dur-press: 160ms`
  - `--dur-pop: 150ms`
  - `--dur-sheet: 320ms`
  - `--dur-exit: 240ms`
  
  Every lane uses these tokens. Every animation has a `prefers-reduced-motion` fallback (opacity only, 120 ms). Haptics are never gated on reduced motion.
- No emoji in UI copy. Icons come from Lucide via `ds/Icon`. There are no em dashes. User-visible copy is Finnish only, never shows internal names (env keys, ids, provider names, "Rajattu tila") and never shows raw server or network errors.
- Verification per lane:
  - typecheck, lint (baseline 11 errors / 27 warnings), and unit tests (baseline: 5 Windows-only failures);
  - integration tests under the lock when the server is touched;
  - **WebKit** iPhone checks (390×844 and 320×568, with safe-area insets injected as in finding BOOKS/`scroll` method: `--safe-top: 47px`, `--safe-bottom: 34px`) on the bundled export served on :3210 against dev :3200. Rebuild the export only in Wave B+ with the lock `mkdir .superpowers/locks/export` (one builder at a time; the others wait).
  - Before/after screenshots go to `C:\Users\Hhusey\lashkirja-shots\batch-1\<lane>\`.
- The dev server is on :3200. Do not restart it; if it is down, report it. Production is off-limits. Never dispatch subagents.
- Commit trailer:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Kh2Zowz8EEz2jUzauogoCu
  ```
- Report: the Write tool refuses report files from subagents. Return the report as text: IDs closed, IDs deferred with reasons, commits, verification, and screenshot paths.

## Wave A (one lane, first): shell and shared infrastructure, lane `infra`

The other lanes build on this contract, so it lands first.

- **Motion tokens:** SHELL-24 (tokens, dead-class cleanup, `.animate-in` ≤300 ms) and SHELL-12 (exit easing for sheets and dialogs).
- **Press feedback:** SHELL-20. Define `active-press` and the `[data-pressed]` scale.
- **Haptics API:** SHELL-19. `lib/haptics.ts` gets `hapticSelection`, `hapticImpact`, `hapticNotify`. Wire them into `Button`, the chip toggles and the `ConfirmModal` confirm.
- **Toasts:** SHELL-23. `ToastHost` plus `showToast({tone,text,action?})`, including a "Kumoa" action. Export it for the other lanes.
- **Errors:** AUTH-09, BOOKS-15, SALES-18. `errorMessage()` maps status codes and network TypeErrors to Finnish, and raw strings go to the console only. Also add a shared `ConnectionNotice`/`ErrorState` with retry.
- **Skeletons:** a `Skeleton` primitive at final sizes (`.skeleton` shimmer 1.6 s linear) plus 150 ms cross-fade helpers. The lanes build page skeletons with it.
- **BottomSheet:**
  - SHELL-03 and AUTH-24: an asymptotic upward drag of at most 60 px, and a bleed under the panel.
  - SHELL-33: drag from the body at `scrollTop` 0.
  - SHELL-29: `focus({preventScroll:true})` and the title as initial focus.
  - SALES-27: a dirty guard for backdrop and swipe close.
  - SHELL-12: exit easing.
- **BottomActions:** SALES-29 and BOOKS-20. An opaque background with a hairline, the spacer equal to the bar height, and an enter/exit slide.
- **AppShell navigation:**
  - SHELL-01 and AUTH-01: the Asetukset row really navigates. Add an e2e test.
  - SHELL-06 and SHELL-07: a persistent `<main>` with the key on an inner wrapper, no animation on tab/none, and scroll restore on back.
  - SHELL-28: snapshot-and-slide push/pop.
  - SHELL-13: the tab bar slides on detail routes.
  - SHELL-31: the back label.
- **Lisää sheet:** SHELL-02 (OWN-04) opens the camera directly, with the stash-and-route contract "`/kuitit/uusi?from=camera` drains the stash". SHELL-30 opens the document picker directly for "Tuo tiliote". The receiving pages' side of both contracts belongs to the `books` lane: `ReceiptEditor` for the camera, and the Tapahtumat import for the file picker. Write that contract into a shared module `lib/pending-capture.ts` in Wave A so the `books` lane only consumes it.
- **Centre "+":** SHELL-17 (OWN-03), 60 px and raised.
- **Scroll:**
  - SHELL-04, BOOKS-08, BOOKS-10 and AUTH-25: one bottom inset owned by `.app-main`, and `pb-6` removed from the page wrappers across the app. This is the only cross-lane edit allowed in Wave A: mechanical class removal only.
  - SHELL-05 and BOOKS-09: `overscroll-behavior-y` so iOS bounces, verified on the Simulator.
  - A Playwright S1 test that fails when `0 < overflow ≤ 64` on the root routes.
- **Launch:** SHELL-08 and SHELL-25, splash timing and no first-render animation.
- **Status bar:** SHELL-18, `style: "LIGHT"`.
- **Orientation:** SHELL-26, portrait only on iPhone (Info.plist).
- **Banners:** SHELL-21. Overlay banners, a retry, and a "Yhteys palautui" confirmation.
- **Other:** SHELL-27 and AUTH-19 (BuildInfo behind a disclosure), AUTH-28 (cached avatar on first paint), SHELL-34 (dashboard skeleton, in coordination with the `sales` lane: infra builds the skeleton component only).

## Wave B (four lanes in parallel, after Wave A is committed)

### Lane `assistant`: AI chat and onboarding
- **AI chat:**
  - SHELL-09 and SHELL-10 (OWN-08): drawer motion, `useSheetDrag`, dialog semantics, focus trap, menu motion.
  - SHELL-11 (OWN-09):
    - remove the "Rajattu tila" label and the developer notice;
    - no retry button when the provider is missing;
    - add `GET /api/ai/status → {available}`;
    - the provider stays GitHub Copilot, and nothing is shown when the token is missing (the owner will add the token).
- **Onboarding:** SHELL-14, 15 and 16 (OWN-11). Rebuild it as the chat-style onboarding exactly as designed in findings-shell "Onboarding: audit and chat-style design": 24 h snooze, draft persistence, no pre-selection, labels in the summary, `z-[75]` above the chrome.
- **Files:**
  - `AiChatDrawer.tsx`, `app/api/ai/**`, `lib/chat-policy.ts`, `lib/ai-assistant.ts`
  - `OnboardingModal.tsx` (it may be replaced by new files under `components/onboarding/`), `lib/onboarding.ts`

### Lane `auth`: auth pages, forms and Asetukset
- All AUTH P0 and P1 items not already taken by `infra`: AUTH-02, 03, 04, 05 (OWN-01), 06, 07, 08, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 21, 22, 23; plus SHELL-22 (bare-frame scroll for the auth pages); P2 AUTH-26, 27, 29, 30, 31 where cheap.
- `PasswordField` is a new ds component (eye toggle ≥44 px, "Näytä salasana"/"Piilota salasana", focus and caret kept) and is used in all 9 secret fields. New passwords and the PIN get a repeat field.
- One shared `useSignOut()` confirm hook, used by the avatar sheet and the Asetukset page (AUTH-03). The avatar-sheet call site in `AppShell` is changed by this lane with a minimal, re-read edit.
- **Files:** `app/src/app/login/**`, `unohtunut-salasana`, `palauta-salasana`, `vahvista-sahkoposti`, `app/src/app/asetukset/**`, `SellerProfileCard.tsx`, `AppLock.tsx` (password field only), `components/ds/PasswordField.tsx`, `lib/form-session.tsx` (if needed).

### Lane `sales`: Koti, Myynti and Raportit
- All SALES P0 and P1 items:
  - SALES-01: income includes the sales invoices in `api/reports/profit-loss`, `api/dashboard` **and `api/alv`**. Check `api/alv` for the same gap, with integration tests for all three.
  - SALES-02 through SALES-30.
- Koti is rebuilt towards mockup `01-koti.png` using the data the API already returns (SALES-16, SALES-35), with the dashboard skeleton from `infra`.
- Confirmations and undo use `ConfirmModal`/`showToast` from `infra`.
- **Files:** `app/src/app/dashboard/**`, `app/src/app/laskut/**`, `app/src/app/asiakkaat/**`, `app/src/app/toistuvat/**`, `app/src/app/raportit/**`, `components/invoices/**`, `CustomerForm.tsx`, `app/src/app/api/{reports,dashboard,alv,invoices,recurring-invoices,export}/**`, `lib/sales-invoices.ts`, `lib/invoice-groups.ts`.

### Lane `books`: Kirjanpito, receipts and bank
- All BOOKS P0 and P1 items:
  - BOOKS-01, 03, 04, 05, 06 (OWN-06): connect-first bank design exactly as in findings-books "Recommended design". The hub connect card, the Pankkitilit reorder, the bank-list sheet, the unconfigured-state card with a "Mitä tarvitaan" sheet, and no raw env names.
  - BOOKS-12 (P0 select-all) and BOOKS-13 through 22.
- The receiving side of the Wave A capture contract: `ReceiptEditor` drains `lib/pending-capture.ts` on `?from=camera` (BOOKS-18, OWN-04), and Tapahtumat opens the import on `?import=1`.
- **Files:** `app/src/app/kirjanpito/**`, `app/src/app/kuitit/**`, `app/src/app/pankki/**`, `app/src/app/tyot/**`, `BankConnectCard.tsx`, `ReceiptEditor.tsx`, `ReceiptPreview.tsx`, `ReceiptUploadArea.tsx`, `QueuedReceiptsCard.tsx`, `StatementDetailView.tsx`, `BooksLockCard.tsx`, `ReviewQueue.tsx`, `lib/work-queue.ts`, `app/src/app/api/{jobs,bank,matching}/**`.

## Wave C: iOS Simulator run, one review, one fix wave, ship
1. Run `ios-sim-check.yml` on the batch head, and inspect the screenshots and video: scroll bounce, safe areas, sheets, camera permission prompt, status bar.
2. Three parallel reviewers (shell+assistant, auth+books, sales+server), then one fix wave.
3. Deploy with `deploy-local.ps1`, build the IPA, and deliver it with before/after screenshots and the closed BACKLOG IDs.

## Owner inputs still needed (not blocking)
- The `COPILOT_GITHUB_TOKEN` value, placed in the production `.env` by the owner.
- Enable Banking credentials: app id, key file, redirect registration (BOOKS-02). The UI must be complete and honest without them.
