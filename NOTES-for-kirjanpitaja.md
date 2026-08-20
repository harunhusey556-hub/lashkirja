# Notes for kirjanpitaja

## 2026-08-20 — Mobile UX overhaul round 1 (hardening-r1, commits 5d88a0d..abad798)

Done by a devteam agent on Harun's complaint ("no sign-out, no back-swipe, everything crammed into settings, doesn't feel like an app").

- **Sign out**: header avatar (every page) opens a profile sheet with Asetukset link + "Kirjaudu ulos"; also a sign-out button at the bottom of /asetukset. `signOut()` in `src/components/clientFetch.ts` destroys the iron-session cookie via POST /api/auth/logout, fades <body> out (opacity only) and lands on /login. Verified: cookie cleared, /api/auth/me → 401.
- **Back-swipe + directional transitions**: `AppShell.tsx` now tracks navigation direction at module scope (route depth + popstate + forced direction). Drill-in slides from right, back from left, tab switch keeps fade-up. Subpages (depth > 1) get a header back chevron and a 24px left-edge swipe-back gesture on <main> (interruptible, velocity/distance commit, inline transform always cleared — never leave a transform on <main>, fixed bars re-anchor).
- **Settings restructure**: /asetukset is a grouped menu; subpages: /asetukset/profiili, /yritys, /laskutus (SellerProfileCard), /kirjanpito (BooksLockCard), /sahkoposti (IMAP + sync). Shared hook `src/app/asetukset/useProfile.tsx`.
- **Motion pass**: BottomSheet + ConfirmModal exit animations (mounted-while-closing pattern, 220/180ms timeout unmount — do NOT rely on animationend, reduced-motion never fires it). Sheet enter is full-height spring (0.32s cubic-bezier(0.32,0.72,0,1)). `SkeletonList` (AsyncState.tsx) replaces spinners on kuitit/tiliotteet/laskut; `.list-stagger` CSS staggers list entrances with `backwards` fill only. Press states (`active-press`) on tab bar, dashboard quick actions, settings forms.
- **Hard constraints re-verified**: login hard-lock (fixed/overflow-hidden/touch-none) intact, login spinner intact, computed transform on <main> is "none" on dashboard/subpage/after back-nav/kuitit, tab-height var + bulk bar untouched, viewport zoom-lock untouched.
- Live service `lashkirja-live` (port 3920) restarted on the new build (CSS hash 1jymxmnge → 1qbdvycsie3sa). Screenshots in /tmp/lk-r1-*.png.

Deferred to round 2: drag-to-dismiss on BottomSheet, per-detail-page skeletons (kuitit/[id], tiliotteet/[id]), haptics via Capacitor, kuitit-page inline "synkronoi" shortcut, converting kuitit's legacy `animate-in ... stagger-N` items (they still use forwards-fill; harmless — not ancestors of fixed elements).
