# LashKirja iOS: why it feels broken, and what a real app needs

Research date 2026-09-28, branch `feat/ux-phase2-design`. Read-only: nothing in the repo was changed. Measurements used a scratch copy of the app with a snapshot of the database, in the session scratchpad. Paths below are relative to `app/` unless they start with the repo root.

---

## 1. TL;DR

1. Most of the slowness comes from the environment. The phone was running `next dev`, which ships 16.1 MB of unminified JS on every full load with no caching, compiles each route on first visit (1–5 s), and sends HMR traffic through a quick tunnel to a home PC. A production build of the same code ships 0.77 MB of immutable JS. Under the same simulated 4G and phone CPU, a full load goes from 4.6–6.0 s to 1.0–1.1 s.
2. Four architecture choices cause the rest, and they stay in production. Every full load runs a client-side auth gate (`/api/auth/me` twice). Page data only starts loading after that gate resolves, so the requests run one after another. A 6–7 request shell warm-up fires on every full load. The tab bar uses `router.push` instead of `<Link>`, so pages are not prefetched.
3. Most likely logout cause (strong evidence; needs a device to confirm): in dev, an HMR full reload (`location.reload`) overlapped with the logout `location.replace("/login")`. WKWebView cancelled one of them. Capacitor 8.5 then loads `errorPath` (`offline.html`) on every provisional-navigation failure, including a plain cancel. That page's "Yritä uudelleen" button only reloads itself, so the app is stuck until it is force-quit.
4. A second bug gives the same "unusable" symptom, and I reproduced it: when a cookie's session has been revoked, `/login` and `/dashboard` redirect to each other forever, with "Tarkistetaan istuntoa…" on screen. The cause is that `proxy.ts` only unseals the cookie and never checks whether the session was revoked.
5. The app depends heavily on its server. It has 95 API routes, SQLite through Prisma/libSQL, uploads on local disk, and native `tesseract`/`pdftotext`/`pdftoppm` binaries. It also uses IMAP/SMTP, Enable Banking signing with a private key, an OpenAI-compatible LLM and a 10-minute worker. It needs a VM or container, not serverless.
6. **A** is the same app on a real EU host with a prod build, plus native polish. It is S/M effort and fixes nearly everything the user saw. **B** bundles the UI in the IPA, with token auth, CORS and universal links. It is L effort. **C** puts SQLite on the device with sync. It is XL, high risk, and the bank, mail and AI parts still need a server.
7. Recommendation: do A now. Build the token-auth and API-client groundwork during A, so B can follow if offline use or a public App Store listing becomes a requirement. Do not do C.
8. The store-quality gaps are all missing today: paid signing and TestFlight, a privacy manifest, push (APNs), crash reporting, off-site backups with a 10-year retention plan, a privacy policy URL, and three stale Info.plist values.

---

## 2. Slowness causes, ranked

### 2.1 Measurements

The script is `scratchpad/perf-measure.js` (desktop Chrome, iPhone 13 emulation, every non-GET except login and logout aborted). Each run had a warm-up pass before the measured pass, so first-visit compile time is excluded. The throttled rows use CDP with 150 ms RTT, 1.5 MB/s down and a 4× CPU slowdown, which is roughly a mid-range phone on 4G. The prod rows are `next build --webpack && next start` of the same source, run from a scratch copy.

| Scenario | Full load → page `h1` | Tab switch → `h1` | JS per full load |
|---|---|---|---|
| dev, loopback, warm | 0.6–0.8 s | 0.07–0.18 s | 16.1 MB decoded, `no-cache`, `main-app.js?v=<timestamp>` |
| dev via the quick tunnel (desktop) | 1.7–2.0 s | 0.17–0.55 s | same |
| dev, throttled | **4.6–6.0 s** (login → dashboard 5.9 s) | **0.66–1.9 s** | same |
| prod, loopback | 0.08–0.13 s | 0.04–0.06 s | 0.77 MB, `max-age=31536000, immutable` |
| prod, throttled | **1.0–1.1 s** (login → dashboard 2.4 s) | **0.14–0.89 s** | same, cached after the first load |

On a phone, dev also pays first-visit compiles that these warm numbers leave out. The dev log shows `GET /laskut 200 in 5.2s (next.js: 4.8s)` and the first API burst at about 1.5 s each (`lashkirja-dev.log` lines 9–27). My probe measured `GET /api/auth/sessions 401 in 5.0s (next.js: 5.0s)`. That matches the user's report: "every page loads and waits, 2–5 s".

### 2.2 Environment causes (a production host removes all of these)

| Rank | Cause | Evidence | Impact |
|---|---|---|---|
| E1 | Dev bundles: 16.1 MB decoded JS per full load, cache-busted by `?v=`, parsed on a phone CPU | `js-weight.js`: `main-app.js` 11.7 MB, `layout.js` 2.3 MB, `dashboard/page.js` 1.7 MB | Several seconds per full load. Prod is 0.77 MB and immutable. |
| E2 | On-demand compilation for every first page or API hit | dev log lines 9, 22–27. Probe: a 5.0 s compile of an API route. | 1–5 s on each first visit after a restart |
| E3 | HMR through the tunnel. Every compile, including ones triggered by other clients, makes every open client rebuild, fetch hot-update chunks and refresh the router. After iOS suspends the app, the socket reconnects and a changed hash forces `window.location.reload()`. | `hmr-reload-probe.js` ("[Fast Refresh] rebuilding" plus hot-update fetches on a foreign compile). `node_modules/next/dist/client/dev/hot-reloader/app/web-socket.js:87-90` (reload on hash change after reconnect) and `:104-110` (reload after 25 failed reconnects). Tunnel log 10:48–10:51 UTC: `_next/webpack-hmr` rejected with `Unauthorized` 50 times, because the tunnel host was not in `allowedDevOrigins` (`next.config.ts:21-34`). | Random full reloads, and the logout race in §3 |
| E4 | Quick tunnel to a home PC: about 180–200 ms extra per request, home uplink, no uptime guarantee | `curl` of `/api/health` through the tunnel: 0.18–0.99 s. Tunnel log line 1 ("no uptime guarantee"). | Every request in the chains below costs more |
| E5 | React Strict Mode double effects in dev. Every page fetch runs twice and the first copy is aborted. | dev tab switch `api=8` for 4 unique endpoints, `failed=4–5`. Prod `api=4`. | Twice the requests, "many aborted requests" |
| E6 | No HTTP caching of documents or chunks in dev | `cache-control: no-cache, must-revalidate` on every chunk | Every full load downloads everything again |

### 2.3 Architecture causes (these remain in production)

| Rank | Cause | Evidence | Why it matters | Fix (size) |
|---|---|---|---|---|
| A1 | **Client-side auth gate, then data, one after the other.** `AppShell` renders `LoadingState "Tarkistetaan istuntoa..."` and does not mount `children` until `/api/auth/me` resolves, so page fetches start only after that. | `src/components/AppShell.tsx:150-154` (initial state is `checking` unless the in-memory cache has the user), `:355-408` (`/me`), `:606-616` (children gated) | Each full load pays HTML → JS → hydrate → `/me` → page data, one after another. At 150 ms RTT that alone is about 1 s. The proxy already unseals the cookie server-side (`src/proxy.ts:46-60`), so the server knows the user before any JS runs. | Have the server component layout read the session and pass the user to `AppShell`, and start page fetches in parallel with `/me`. (M) |
| A2 | **`/api/auth/me` twice per full load.** `AppLock` fetches it separately, with no signal. `AppShell`'s call passes an `AbortSignal`, which opts it out of the in-flight de-duplication. | `src/components/AppLock.tsx:93-115`, `src/components/AppShell.tsx:358-361`, `src/components/clientFetch.ts:116-119` (a `signal` makes the request non-shareable) | One extra round trip and one extra DB query per full load | One shared session source, such as a context from A1. (S) |
| A3 | **Shell warm-up burst on every full load.** `warmTabCaches()` fires `/api/receipts` twice, `/api/statements`, `/api/bank-accounts`, `/api/invoices` and `/api/dashboard`, plus `/api/onboarding`, whatever the page is. The `warmedTabs` flag is module state, so it resets on every document load. | `src/components/AppShell.tsx:91-134`, called at `:374`. Every full load in the measurements shows these 7 requests, e.g. `/raportit` needs 1 but loads 10. | Competes with the page's own data for the same connection and SQLite. On a first dev visit each one also compiles. | Warm lazily with `requestIdleCallback` after the page's data, or not at all when a persistent cache exists. (S) |
| A4 | **Tabs are buttons calling `router.push`, not `<Link>`, so nothing is prefetched.** Each tab switch waits for the RSC payload over the network, then for the page's API calls. | `src/components/AppShell.tsx:136-146`, `:458-477`, `:500-517`. Prod throttled tab switch: 0.14–0.89 s, mostly the RSC round trip. | The main in-app navigation feels laggy on mobile networks | `router.prefetch()` for the 4 roots on mount, or `<Link prefetch>`. Also check that the proxy's `Cache-Control: private, no-store` on every protected page (`src/proxy.ts:94-100`) does not defeat the client router cache for static routes. (S) |
| A5 | **All data is fetched on the client after hydration.** Every page renders a `"use client"` component that fetches in `useEffect`. Only `/` and `/dashboard` read the session on the server, and neither streams data. The other 4 server files are thin Suspense wrappers (`layout`, `login`, and 2 under `pankki/tapahtumat`). | Page classification in §4.3. `ARCHITECTURE.md` line 38 ("only `/` and `/dashboard` are server-gated") | No streaming. First paint is always a skeleton. Detail pages fetch in a chain (entity, then related lists). | Keep it this way if B is planned: a client-fetch design ports straight to a bundled UI. For A, the gains come from A1, A3 and A6 rather than a rewrite to RSC. |
| A6 | **The cache lives only in memory.** It holds 40 entries for 5 minutes and is deliberately not persisted. | `src/lib/page-cache.ts:1-15`, `app/docs/perf-budgets.md` last line | Every app launch, WebView reload or HMR reload starts from nothing, and every screen shows skeletons again | A persistent stale-while-revalidate cache (IndexedDB, or Capacitor Preferences/SQLite for B), wiped on logout. (M) |
| A7 | **Full-document navigations** are used for login (HTML form POST → 303), logout, 401 handling, and deep links | `src/app/login/LoginForm.tsx:54`, `src/components/clientFetch.ts:204-241`, `src/components/ShellGate.tsx:19-23` | Each one reloads the whole shell, pays A1–A3 again, and gives the WebView a chance to cancel a navigation (§3) | Client-side login and logout that reset state without reloading the document. (S/M) |
| A8 | Heavy server-only dependency: `libheif-js` WASM enters `/api/receipts` through `lib/ai.ts → heic-convert` | dev log "Critical dependency … libheif-bundle.js" trace | Not in the client bundle (verified: 0.77 MB total). In dev it makes the `/api/receipts` compile slow. In prod it only costs cold-start memory. | Lazy `import()` inside the HEIC branch. (S) |

**What a production host fixes:** E1–E6 entirely. A throttled full load drops from about 5 s to about 1 s, and a warm tab switch from about 1–2 s to about 0.1–0.9 s. The random reloads and the logout race go away.

**What stays slow in production:**
- The about 1 s full-load chain (A1+A2), which matters most at app launch.
- Tab switches that go to the network without prefetch (A4).
- The warm-up burst (A3).
- Relaunches with no cache (A6).

With A1–A4 and A6 fixed, a launch should paint cached data in well under 0.5 s and tab switches should be instant. That estimate is not measured.

---

## 3. The logout failure inside Capacitor/WKWebView

### 3.1 What happened (most likely)

Evidence chain:

1. `lashkirja-dev.log:484-485`: `POST /api/auth/logout 200 in 657ms (next.js: 641ms…)`, then `⚠ Fast Refresh had to perform a full reload`.
   - 641 ms of "next.js" time is the first on-demand compile of the logout route.
   - That warning is printed only when a browser with a live HMR socket sends `client-full-reload`. It does that from `performFullReload()`, which then calls `window.location.reload()` (`node_modules/next/dist/client/dev/hot-reloader/app/hot-reloader-app.js:106-117`; server side `node_modules/next/dist/server/dev/hot-reloader-webpack.js:425-461`).
   - The HMR errors stop after 10:51 UTC in the tunnel log, so the phone's HMR socket was connected at that point. My probe confirmed that any compile, including an API route triggered by another client, makes each connected client rebuild and fetch hot-update chunks. A client whose hash is stale, for example after iOS suspended the WebView, cannot apply the update and falls back to `location.reload()`.
2. At the same moment, `leaveAfterSignOut()` adds `body.signing-out`, waits 240 ms and calls `window.location.replace("/login")` (`src/components/clientFetch.ts:234-241`). Two top-level navigations now overlap. WebKit cancels the earlier provisional navigation with `NSURLErrorCancelled` (-999).
3. **Capacitor 8.5 treats a cancel as a load failure.** `node_modules/@capacitor/ios/Capacitor/Capacitor/WebViewDelegationHandler.swift:149-153` (and `:133-143` for `didFail`) calls `webView.load(errorPathURL)` for any error, with no check for -999. The installed IPA has `"errorPath": "offline.html"` and `public/offline.html`. I verified this by unzipping `scratchpad/ipa/Tilikirja-unsigned.ipa`, which was built at 13:56 with the tunnel URL. Loading the local `capacitor://localhost/offline.html` cancels whichever server navigation was still pending. That explains why the dev log shows no `GET /login` or `GET /<page>` afterwards.
4. **The offline page cannot recover.** Its only button is `onclick="location.reload()"` (`public/offline.html:53`). That reloads `capacitor://localhost/offline.html`, not the server. The app stays on "Sovellusta ei saatu ladattua" until iOS kills it.

Confirmed from code: steps 1 and 2 (the dev log and the Next source), step 3 (the Capacitor source and the IPA contents) and step 4 (the file).

Needs a device: whether the phone actually showed the offline page. The alternative is the blank screen in 3.2 H2. Also whether the `client-full-reload` came from the phone and not another open browser. Confirm with Safari Web Inspector on a Mac (Develop → iPhone → the app), or a screenshot of the stuck screen.

### 3.2 Hypotheses, one by one

| # | Hypothesis | Verdict | Evidence |
|---|---|---|---|
| H1 | HMR full reload racing `location.replace`, and Capacitor's `errorPath`-on-cancel leaving the app on `offline.html` | **Most likely.** Mechanism confirmed in code; the screen needs a device. | §3.1 |
| H2 | `signing-out` leaves `<body>` at `opacity:0; pointer-events:none` if the navigation never commits | **Possible, and a real latent bug.** Nothing ever removes the class and there is no fallback timer. If the replaced navigation is dropped (by a cancel without `errorPath`, or a blocked navigation) the result is a blank, untappable screen. | `src/app/globals.css:702-706`, `src/components/clientFetch.ts:237-239` |
| H3 | A cookie survives while its session row is revoked, causing a redirect loop | **Confirmed bug, reproduced** (`scratchpad/revoked-cookie-loop.js`: 13 navigations in 15 s, stuck on "Tarkistetaan istuntoa..."). Probably not this incident, since the dev log shows no requests after logout. It hits after "log out everywhere", a password reset, an account close, a logout whose response was lost, or a cookie deletion the WebView did not apply. | `src/proxy.ts:46-60` only unseals. `:89` sends an "authenticated" `/login` to `/dashboard`. `src/app/dashboard/page.tsx` only checks `session.userId`. `/api/auth/me` returns 401 for the revoked row (`src/lib/session.ts:47`) but does not clear the cookie (`src/app/api/auth/me/route.ts:5-7`). `redirectToLogin()` goes to `/login?error=expired`, and the proxy sends that back to `/dashboard`. |
| H4 | `AppLock` or a biometric state in Capacitor Preferences surviving logout | **Refuted.** There is no `@capacitor/preferences` dependency. The lock is `localStorage` scoped by user id. `AppLock` is only mounted inside `AppShell`, and `ShellGate` renders `/login` bare. | `package.json`, `src/lib/app-lock.ts:73-75`, `src/components/ShellGate.tsx:34-40`, `app/docs/app-lock.md` |
| H5 | `location.replace` blocked for a remote `server.url` | **Refuted for same-origin.** `decidePolicyFor` allows URLs that start with `serverURL` (`WebViewDelegationHandler.swift:104-118`). | — |
| H6 | `lashkirja://` or `appUrlOpen` handling | **Not the cause, but a latent risk.** `watchBankDeepLink` calls `App.getLaunchUrl()` on every `ShellGate` mount. If the app was cold-launched from a `lashkirja://bank/callback` link, every later full document load, including `/login` after logout, jumps to `/bank/callback` again. Needs a device. | `src/lib/open-bank-auth.ts:52-71`, `src/components/ShellGate.tsx:17-30` |
| H7 | WKWebView cookie behaviour | **Unlikely here.** The cookie is first-party over HTTPS, `SameSite=Lax`, `HttpOnly`, and set by the same origin (`src/lib/session-options.ts:26-34`). In dev the name is `lashkirja-session`. In prod it is `__Host-lashkirja-session`, so a phone that has seen both keeps two cookies until logout. Combined with H3, a stale one can loop. | — |

### 3.3 Fixes (all small)

1. Never point an IPA at `next dev`. That removes the H1 trigger.
2. `leaveAfterSignOut`: navigate once, without the 240 ms gap. Add a fallback that removes `signing-out` and shows an error if the page is still alive after about 3 s.
3. Native: subclass `CAPBridgeViewController` or the delegation handler so that `NSURLErrorCancelled` never loads `errorPath`. Make `offline.html` retry navigate to the server URL (inject it at `cap sync`) instead of `location.reload()`.
4. Sessions: have the proxy (Node runtime in Next 16, `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md:221-223`) check the `AuthSession` row, or at least have `/api/auth/me` and `/login?error=expired` destroy the cookie. Never send an expired login back to `/dashboard`.
5. Have `watchBankDeepLink` consume the launch URL only once per process, for example with a flag in `sessionStorage`.

---

## 4. Server-side dependency inventory

### 4.1 Runtime services

| Dependency | Where | Hosting implication |
|---|---|---|
| **95 API route handlers** | `src/app/api/**/route.ts`: auth (login, logout, me, sessions, password, email), receipts, invoices, purchase invoices, statements, matching, bank, customers, AI chat, export, jobs, onboarding, profile, period-lock, reports, uploads, observe, health, cron | A Node server is required under any architecture |
| **SQLite via Prisma 7 + `@prisma/adapter-libsql`**: 34 models, 30 migrations, WAL mode | `prisma/schema.prisma`, `src/lib/db.ts:9-35`. The default is `file:../data/lashkirja.db`. | Needs one writer on a persistent disk. libSQL means Turso (hosted libSQL) is possible later without changing the ORM. |
| **Uploads on local disk** | `src/lib/storage.ts:99-100` (`process.cwd()/data/uploads`) | Needs a persistent volume, or a port to S3-compatible storage. Backups must copy it (`scripts/backup-db.sh`). |
| **Background worker**: IMAP sync, bank sync (with a 6 h gate), document-job drain, every 10 min | `scripts/worker.ts` (a `setInterval` loop) | A second long-running process (systemd or a compose service) |
| **Cron endpoints**: `cleanup`, `recurring-invoices`, `sync-bank`, `sync-email`, public but gated by `CRON_SECRET` | `src/app/api/cron/*/route.ts`, `src/proxy.ts:31` | An external scheduler (systemd timer or cron with curl) |
| **Enable Banking**: JWT signed with a private key; `redirect_url` must be an absolute http(s) URL | `src/lib/enablebanking/signing.ts:70-89`, `client.ts:321`. The consent completes via `POST /api/bank/connections/callback` with `code` and `state`, and requires a session (`src/app/api/bank/connections/callback/route.ts:16-37`). The UI page is `src/app/bank/callback/page.tsx`. | The key must stay on the server. The redirect URL needs a stable HTTPS domain. A quick tunnel changes URL on every restart, and each change breaks the registered redirect. |
| **Email**: IMAP (`imapflow`), SMTP (`nodemailer`, including `PLATFORM_SMTP_*` for password mail) | `src/lib/mail-sync.ts:1`, `src/lib/mailer.ts:8,76-77` | Outbound 993/465/587 from the host; stored mailbox passwords encrypted with AES-256-GCM |
| **OCR, local binaries**: `tesseract` (fin+swe+eng), `pdftotext`, `pdftoppm` (poppler) | `src/lib/ai.ts:398-410, 461-463, 509-535`, `src/lib/parsers.ts:919-997` (`execFileSync`) | **Rules out serverless** (Vercel, Netlify). Needs a Docker image or VM with these packages and language data. |
| **AI**: an OpenAI-compatible endpoint (`LLM_BASE_URL`, default api.openai.com, `gpt-4o-mini`) or the GitHub Copilot model; gated by `CLOUD_AI_ENABLED` | `src/lib/ai.ts:88, 208, 292-306` | An API key on the server. A GDPR processor (DPA) when enabled. |
| **PDF generation**: `pdfkit`, kept outside the bundle | `src/lib/invoice-pdf.ts:8,92`, `next.config.ts` `serverExternalPackages` | Node only. Reads `.afm` files from `node_modules`. |
| **HEIC conversion**: `heic-convert` / `libheif-js` WASM | `src/lib/ai.ts`, `src/lib/storage.ts`, `src/lib/preview.ts` | Memory at conversion time |
| **iron-session cookies**: 30-day TTL, `__Host-` + `Secure` in prod, plus `AuthSession` rows for revocation | `src/lib/session-options.ts`, `src/lib/session.ts:34-57`, `src/proxy.ts` | Cookies only work same-origin, so this blocks B as it is |
| **CSRF / origin guard**: rejects `sec-fetch-site: cross-site` and any `Origin` other than `APP_ORIGIN` | `src/lib/http-security.ts:30-45`, `guardWrite` `:59-61` | A bundled app (origin `capacitor://localhost`) would fail every write |
| **Observability**: `/api/observe`, `/api/health`, optional `SENTRY_DSN` or webhook | `app/docs/ops.md` | Works on any host |

### 4.2 Environment variables read by code

`APP_ORIGIN`, `DATABASE_URL`, `SESSION_SECRET`, `COOKIE_SECURE`, `TRUST_PROXY`, `HEALTH_TOKEN`, `CRON_SECRET`, `ENABLEBANKING_{ENABLED,APP_ID,KEY_FILE,KEY_PEM,REDIRECT_URL,API_BASE}`, `LLM_{API_KEY,BASE_URL,MODEL}`, `CLOUD_AI_ENABLED`, `COPILOT_{GITHUB_TOKEN,MODEL}`, `SMTP_HOST`, `MAIL_TRANSPORT`, `SENTRY_DSN`, `OBSERVE_WEBHOOK_URL`, `SLOW_QUERY_MS`, and `ALLOWED_DEV_ORIGINS` (dev only).

The current `.env` sets only `DATABASE_URL`, `SESSION_SECRET`, `CRON_SECRET` and `ENABLEBANKING_*` (key names checked, values not read).

### 4.3 Pages and server-only APIs (what blocks `output: "export"`)

The prod build output (scratch copy) shows every page as static (`○`) except the ones below. Static-export blockers are from `node_modules/next/dist/docs/01-app/02-guides/static-exports.md:274-292`.

| Blocker | Where | Change for export |
|---|---|---|
| `cookies()` via `getSession()` | `src/app/page.tsx` (redirect), `src/app/dashboard/page.tsx` (redirect plus `firstName`) | Make them client components. Take `firstName` from `/me`. |
| Dynamic segments without `generateStaticParams` | `asiakkaat/[id]`, `kuitit/[id]`, `laskut/[id]`, `pankki/tapahtumat/[id]` | Query-param routes (`/laskut/lasku?id=…`), or one pre-rendered shell per segment that reads the id on the client. All four are already client components. |
| `proxy.ts` | `src/proxy.ts` | Page gating moves to the client (it is mostly client already). API gating stays on the API server. |
| `headers()` (CSP, HSTS and so on) and `redirects()` | `next.config.ts` | The CSP goes into a `<meta>` or native config. The 9 legacy redirects become client redirects or are dropped. |
| 95 route handlers | `src/app/api/**` | Deployed separately: the same Next app, running as an API-only server |
| An HTML form POST login | `src/app/login/LoginForm.tsx:54` | A JSON login that returns a token |
| Other than the above, the client pages port as-is | All of them fetch through `apiFetch` (87 call sites) plus 4 raw `fetch` calls (`palauta-salasana`, `unohtunut-salasana`, `vahvista-sahkoposti`, `AiChatDrawer.tsx:320`) | One choke point (`src/components/clientFetch.ts:116-177`) for the base URL and the auth header |
| Cookie-authenticated file URLs | 7 `href`/`src` values pointing at `/api/...` (for example `raportit/page.tsx:317,327`, `laskut/[id]/page.tsx:730`, `asetukset/tietosuoja/page.tsx:125`, `ReceiptEditor.tsx:626-628`) | Short-lived signed URLs, or fetch as a blob with the token and hand it to Share or Filesystem |

---

## 5. Architecture options

### 5.1 Comparison

| | **A. Same app on a real host, plus native polish** | **B. UI bundled in the IPA, hosted API with tokens** | **C. Local-first SQLite on the phone, with sync** |
|---|---|---|---|
| What the user gets | Fast (about 1 s cold launch, sub-second tabs after A1–A4), reliable login and logout, splash, Face ID, camera, share sheet, and push once added. Needs a network. Every web deploy updates the app instantly. | Instant launch and navigation from local files. Cached data readable offline. Receipt photos queued offline and uploaded later. UI changes need a new IPA, or a live-update service. | Fully offline, instant. Bank, mail, AI and invoice mail still need the server. Sync conflicts are possible across devices. |
| Feasibility | High. The code already targets this (`IOS-BUILD.md`, `app/docs/deploy-rollback.md`). | Medium-high. All pages already fetch on the client, but auth, CSRF, files, deep links and dynamic routes all change. | Low-medium. There is no supported Prisma adapter for Capacitor SQLite. Domain logic in `src/lib` (VAT, matching, reports, invoices) would have to run on the device, and sync would have to be built. |
| Effort | **S–M** overall (about 1–2 weeks) | **L** (about 4–8 weeks on top of A's server work) | **XL** (months) |
| Main risks | Apple guideline 4.2 ("minimum functionality") for a remote-URL wrapper if published publicly. Mitigated by native camera, Face ID, push, share and offline handling. TestFlight internal testing has no App Review. | Two deploy clocks (IPA and API) and API versioning. Token storage and security. Bank OAuth via universal link. Offline cache of financial data on the device (needs encryption plus a wipe on logout). | Data loss or divergence in bookkeeping data covered by the 10-year retention law. Duplicated business logic. Security of the local DB. |
| App Store | Acceptable for private use via TestFlight. Public listing possible, with some 4.2 risk. | Clean: a real bundled app | Clean |

### 5.2 What changes in this codebase

**A. Production host (ordered)**
1. **Host (S):** An EU VM (for example Hetzner, Helsinki) with Docker Compose running three services: `web` (`next build && next start`, with `TRUST_PROXY` and `APP_ORIGIN`), `worker` (`npm run worker`), and Caddy for TLS.
   - The image needs `tesseract-ocr` with the `fin`/`swe`/`eng` language data, `poppler-utils` and `sqlite3` (the backup script refuses to run without it).
   - Mount a persistent volume for `data/` (the database and `uploads/`).
   - Run `prisma migrate deploy` before `web` starts (`app/docs/deploy-rollback.md` "Order").
   - A stable domain such as `app.<domain>.fi`.
2. **Cron and worker (S):** systemd timers or cron call `/api/cron/*` with `CRON_SECRET`, and the worker runs as its own service.
3. **Secrets (S):** `SESSION_SECRET`, `COOKIE_SECURE=true`, `HEALTH_TOKEN`, `ENABLEBANKING_REDIRECT_URL=https://<domain>/bank/callback` (registered in the Enable Banking control panel), `LLM_API_KEY`, `PLATFORM_SMTP_*`, `SENTRY_DSN`.
4. **Backups (S):** a nightly `scripts/backup-db.sh` with `LASHKIRJA_BACKUP_REMOTE` pointing at off-site storage (for example a Storage Box or S3-compatible bucket), a monthly `restore-drill.sh`, and a retention policy (§6).
5. **Bug fixes from §3.3 (S).**
6. **Performance A1–A4, A6 (M).** A7 is optional.
7. **Native polish (M):**
   - Hide the splash when the app is ready (`launchAutoHide: false` plus `SplashScreen.hide()` after the first paint).
   - The offline and cancel handling from §3.3.
   - Universal links (`apple-app-site-association` on the domain, plus the Associated Domains entitlement) so the bank's HTTPS callback returns into the app.
   - Push (see §6).
8. **CI/signing (S–M):** extend `build-ipa.yml` from unsigned to signed and upload to TestFlight (App Store Connect API key; `ExportOptions.plist` method `app-store-connect` instead of `development`).

**B. Bundled UI (on top of A's server work)**
- **Build:** `output: "export"` for a UI target (or a separate Vite SPA that reuses `src/components` and `src/lib`). Remove the blockers in §4.3. Set `webDir` to the export output and **remove `server.url`**.
- **Auth:** add a token issued by `POST /api/auth/token`, tied to an `AuthSession` row (revocation already exists, `src/lib/session.ts:45-57`). Keep it in the iOS Keychain through a secure-storage plugin, not `localStorage`. Have `requireSession(req)` accept `Authorization: Bearer`. `apiFetch` adds the header and the API base URL. Keep cookie auth for the web.
- **CSRF and CORS:** `guardWrite` skips the origin check for bearer requests. The API answers `OPTIONS` and sends `Access-Control-Allow-Origin: capacitor://localhost` (plus `https://localhost` for Android) and `Access-Control-Allow-Headers: Authorization, Content-Type, Idempotency-Key`. The alternative is `CapacitorHttp` (native HTTP, no CORS), but it changes streaming for the AI chat.
- **Files:** use signed URLs for images and PDFs, or blob plus Share (§4.3).
- **Bank OAuth:** open the bank with `ASWebAuthenticationSession` (a Browser plugin) and set `redirect_url` to an HTTPS universal link. Custom schemes are probably not accepted by Enable Banking; verify. The app receives `code`/`state` via `appUrlOpen` and POSTs to `/api/bank/connections/callback`, an endpoint that already exists.
- **Deep links:** the same universal-link domain, with `watchBankDeepLink` reworked per §3.3.5.
- **Offline:** a persistent, encrypted read cache (A6). Persist `useReceiptUploadQueue` (`src/lib/upload-queue.ts`) to Filesystem and retry. Show an offline banner instead of `offline.html`.
- **Release:** version the API and gate old IPAs, and decide on live updates (App Store guideline 3.3.2 allows JS/HTML updates that do not change the app's purpose).

**C. Local-first**
- Everything in B, plus `@capacitor-community/sqlite`, a local schema that mirrors the 34 models, and a data layer that is not Prisma (or a custom driver adapter).
- The `src/lib` logic (VAT, matching, reports, invoice numbering, period locks) would run on the device.
- It needs a sync protocol with conflict rules, which bookkeeping data (locked periods, invoice sequences) makes hard.
- Enable Banking signing, IMAP, SMTP, LLM keys, server-side OCR and the 10-year archive stay on the server anyway.

### 5.3 Recommendation

**Do A now, in three steps:**
- **A0 (days):** a real host, prod build, stable domain and the §3.3 fixes. This alone removes the slowness and the stuck logout the user saw.
- **A1:** the performance fixes A1–A4 and A6.
- **A2:** TestFlight signing, push for missing-receipt nudges, universal links, and the store checklist.

Reasoning:
- Every symptom the user reported comes from the dev server, the tunnel, two navigation bugs and a missing cache. None of them comes from the WebView model itself.
- A reuses 100% of the existing code and the deploy docs that already describe exactly this model (`IOS-BUILD.md`, `app/docs/deploy-rollback.md`).
- B's value is offline use and store compliance. Both are unknown requirements until the owner answers §7. Build B's groundwork during A anyway: bearer-token auth, a base URL in `apiFetch`, signed file URLs, universal links and the persistent cache. Then B is a build-target change, not a rewrite.
- C is not justified for a single-user bookkeeping app whose core integrations are server-bound.

---

## 6. Store-readiness checklist

Status: ✅ exists, ⚠ partial or wrong, ❌ missing.

| Item | Status | Evidence / action |
|---|---|---|
| Apple Developer Program ($99/yr) | ❌ unknown | `IOS-BUILD.md` says a free Apple ID gives 7-day signatures. Current builds are unsigned (`.github/workflows/build-ipa.yml`, `CODE_SIGNING_ALLOWED=NO`). |
| Signing, provisioning, TestFlight upload | ❌ | `ios/ExportOptions.plist` uses method `development`. Add an App Store Connect API key secret, `-allowProvisioningUpdates` or fastlane match, method `app-store-connect`, and an upload step (`xcodebuild -exportArchive` with `destination: upload`, or `xcrun altool --upload-app`). Internal TestFlight needs no review; builds expire after 90 days. |
| Version and build numbering | ⚠ | `MARKETING_VERSION = 1.0`, `CURRENT_PROJECT_VERSION = 1` are hard-coded in `project.pbxproj`. CI must increment the build number. |
| App name consistency | ⚠ | Native name is "Tilikirja" (`capacitor.config.ts`, `Info.plist` `CFBundleDisplayName`). Web name is "LashKirja" (`src/app/layout.tsx` metadata, UI). Pick one. |
| App icon | ✅ | A single 1024×1024 universal icon, RGB with no alpha (`Assets.xcassets/AppIcon.appiconset`). Valid for Xcode 14+. |
| Launch screen / splash | ⚠ | Storyboard plus a 2732² splash exist. `launchAutoHide: true` hides it before the remote page paints, which shows a canvas-colour flash and then "Tarkistetaan istuntoa…". Hide it on app ready. |
| Info.plist hygiene | ⚠ | `UIRequiredDeviceCapabilities = armv7` (should be `arm64`, or removed). `CFBundleDevelopmentRegion = en` for a Finnish-only app. Landscape is enabled on iPhone for a portrait UI. `ITSAppUsesNonExemptEncryption` is missing (set it `false`; the app uses standard HTTPS only). The URL scheme is patched in after sync (`scripts/patch-ios-url-scheme.ts`). |
| Permission strings | ✅ | Camera, photo library, photo add, Face ID are in Finnish (`ios/App/App/Info.plist`). None are needed for the Files picker. |
| Privacy manifest (`PrivacyInfo.xcprivacy`) for the app target | ❌ | Only the Capacitor and Cordova frameworks ship one (seen in the IPA). The app needs its own: required-reason APIs (UserDefaults, file timestamps, as used by the plugins) and collected data types (financial info, email, photos, user content). App Store Connect privacy labels need to match. |
| Privacy policy URL, support URL | ❌ | Required by App Store Connect. Could be served from the host. |
| Account deletion (guideline 5.1.1(v)) | ✅/n.a. | The app has no in-app sign-up. A close request exists (`src/app/asetukset/tietosuoja/page.tsx`, `app/docs/account-recovery.md`). |
| Review access | ❌ | For a public listing: a demo account plus reviewer notes. TestFlight internal testing does not need them. |
| Guideline 4.2 (thin web wrapper) | ⚠ | Under A the app is a remote-URL wrapper with native camera, Face ID, haptics and share. Adding push and offline handling strengthens the case. Under B it is not an issue. |
| Push notifications (missing-receipt nudges) | ❌ | Missing pieces: no `@capacitor/push-notifications`, no `aps-environment` entitlement (there is no `.entitlements` file), no device-token table, no APNs sender (`.p8` key) in the worker, and no notification permission prompt UX. The product spec already wants it (`docs/superpowers/specs/2026-09-27-ux-restructure-design.md:20`). Size M–L. The server decides when to nudge (the worker already sees bank rows without receipts). |
| Background refresh | ❌ (and not needed) | There are no `UIBackgroundModes`. iOS background fetch is unreliable. Nudges should come from the server via push, not from device polling. |
| Crash reporting | ⚠ | JS errors reach `/api/observe` and Sentry via the server (`app/docs/ops.md`). There is no native crash reporter; add Sentry Capacitor or Crashlytics. |
| Offline / error page | ⚠ | `offline.html` exists but traps the user (§3). |
| Deep links / bank return | ⚠ | Custom scheme only, patched after sync. It needs universal links on the real domain, and the `getLaunchUrl` re-fire fix. |
| Data backup | ⚠ | Good scripts with a manifest, hash checks and a restore drill (`app/docs/backup.md`, `scripts/backup-db.sh`, `scripts/restore-drill.sh`). Nothing schedules them yet. It keeps 7 local snapshots and copies off-site only when `LASHKIRJA_BACKUP_REMOTE` is set. |
| Bookkeeping retention (kirjanpitolaki 2:10 §: books and financial statements 10 years, vouchers 6 years; verify with an accountant) | ⚠ | Records are kept after an account close (`app/docs/ops.md`), and an export package exists (`/api/export/package`). Missing: a long-term off-site archive policy (for example yearly immutable exports plus off-site copies kept for 10+ years), and a guarantee the host and backups stay in the EU. |
| GDPR | ⚠ | Export and close requests exist, and logs are redacted (`app/docs/ops.md`). Missing: a privacy policy, a record of processing, DPAs with the host, the LLM provider and Enable Banking, EU data residency, and an on-device data wipe on logout (the page cache is already cleared; the drafts in `localStorage` are cleared by `clearAllDrafts`). |
| CI | ✅ | `.github/workflows/ci.yml` runs typecheck, unit, integration and build. `build-ipa.yml` builds unsigned. |
| Hosting cost (rough 2026 list prices, verify) | — | For A: a VM (2 vCPU/4 GB, EU) about €5–10/month, VM backups about €1–2/month, off-site backup storage about €3–5/month, a `.fi` domain about €10–20/year, Apple $99/year, LLM receipts at about 150 per month for a few €/month, Sentry free tier. **Roughly €10–20/month plus $99/year.** Check Enable Banking production pricing and its restricted mode separately. B adds nothing on the server side. Serverless hosts do not fit (native OCR binaries, local disk, long-running worker). |

---

## 7. Open questions only the owner can answer

1. **What exactly was on screen after logout?** The "Sovellusta ei saatu ladattua" page, a blank screen, or an endless "Tarkistetaan istuntoa…"? Did force-quitting the app fix it?
2. **Hosting budget:** is about €10–20/month (plus $99/year for Apple) acceptable? Is there a preferred provider or country (EU/Finland data residency)?
3. **Domain:** is there a domain for the app (needed for HTTPS, the Enable Banking redirect, universal links, the privacy policy)? Which name, "LashKirja" or "Tilikirja"?
4. **Apple Developer account:** do you have one ($99/year), or should one be created? In your own name or a company's (a company needs a D-U-N-S number)?
5. **Distribution:** only on your own phone (TestFlight or ad hoc is enough), or a public App Store listing for other entrepreneurs? This decides whether guideline 4.2 and option B matter.
6. **Other users:** will anyone besides you use it (multi-tenant hosting, support, a DPA and privacy policy for customers, a sign-up flow)?
7. **Offline:** do you need to read the books or take receipt photos without a network (for example in the salon's basement)? If yes, plan B's offline cache and upload queue.
8. **Push:** do you want missing-receipt nudges as push notifications, and at what cadence (daily, weekly, month-end)?
9. **Bank:** is Enable Banking in production or restricted mode, and which redirect URL is registered today?
10. **Data custody:** who keeps the 10-year archive (off-site backups, your accountant, both), and is cloud AI (LLM) processing of receipts acceptable under your privacy policy?
11. **Merit Aktiva cutover** (existing decision): does the phone app need to work before the Merit connection is cut, which affects which host runs the read-only sync?

---

*Scripts used (scratchpad, not committed): `perf-measure.js`, `perf-throttled.js`, `js-weight.js`, `hmr-reload-probe.js`, `revoked-cookie-loop.js`. The prod build was run from `scratchpad/prodbuild` against a `VACUUM INTO` snapshot of the database, and its server was stopped afterwards. The dev server on :3200 was not restarted.*
