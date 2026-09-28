# Real App B: Bundled UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Review mode for this project: implementer-only, one final review at the end (owner preference).

## Sahibin göreceği sonuç (Owner-visible result)

- Yeni IPA birkaç MB olacak, çünkü arayüzün tamamı artık telefonun içinde. Uygulama bilgisayardan sayfa indirmeden, anında açılır.
- Açılışta son görülen veriler hemen ekranda olur ve arka planda sessizce tazelenir. "Tarkistetaan istuntoa…" ekranı gider.
- İnternet ya da bilgisayar kapalıyken üstte net bir "Ei verkkoyhteyttä" şeridi çıkar. Uygulama "yüklenemedi" sayfasına düşmez, hiçbir düğme sonsuza kadar dönmez.
- İnternetsizken çekilen fiş fotoğrafları sıraya girer, uygulama kapatılsa bile kaybolmaz. Bağlantı gelince kendiliğinden yüklenir ve "Tarkistettavat" listesine düşer.
- Fatura PDF'leri, dışa aktarımlar ve fiş dosyaları iPhone'un paylaşma ekranıyla açılır, kaydedilir veya gönderilir.
- Giriş bir kez yapılır, oturum iPhone Anahtar Zinciri'nde saklanır. Veriler, banka, e-posta ve yapay zekâ yine bilgisayardaki sunucuda kalır. Sunucu taşınırsa sadece tek bir adres değişir.
- Bilgisayardaki tarayıcı sürümü aynen çalışır. Sadece detay sayfalarının adresleri değişir (`/laskut/lasku?id=…`), eski linkler otomatik yönlendirilir.

---

**Goal:** Ship the LashKirja iOS app with the whole UI bundled inside the IPA (served from `capacitor://localhost`), talking to the existing server API with a bearer token, tolerant of no network, with the web version still built from the same codebase.

**Architecture:** One Next.js 16 codebase, two build targets. The default target stays the web app (server, proxy, cookies, 95 route handlers). `BUILD_TARGET=mobile` produces a static export (`output: "export"`, `pageExtensions: ["tsx"]` so `route.ts` and `proxy.ts` drop out) that Capacitor bundles as `webDir`. The bundle calls `NEXT_PUBLIC_API_BASE_URL` with `Authorization: Bearer <token>` (token in the iOS Keychain). The server accepts bearer tokens next to cookies, answers CORS for `capacitor://localhost` only, and keeps its rate limits and no-enumeration rules. Client state that must survive a relaunch (GET cache, receipt-photo queue) lives in encrypted IndexedDB.

**Tech Stack:** Next.js 16.2 App Router (read `app/node_modules/next/dist/docs/` before writing code; this is not the Next.js you know), React 19, Prisma 7 + SQLite (libsql), iron-session 8, Capacitor 8.5 iOS (SPM), `@aparajita/capacitor-secure-storage` (Keychain), `@capacitor/browser`, `@capacitor/network`, Vitest 4, Playwright 1.62 with installed Chrome.

**Spec:** `docs/superpowers/specs/2026-09-28-real-app-roadmap.md` (Faz 4, "App Store'a hazırlık (B'nin temeli)", plus the Faz 2 speed items A1 to A6). Evidence with file:line references: `docs/superpowers/research/2026-09-28-real-app-findings.md` §2.3 (A1 to A8), §3 (logout and native failures), §4.3 (export blockers), §5.2 "B. Bundled UI". Server setup: `.superpowers/sdd/2026-09-28-real-app-phase01/task-3-report.md` and `app/docs/ops-windows.md`.

## Global Constraints

- **Branch and repo:** `C:\Users\Hhusey\lashkirja`, app in `app/`, branch `feat/real-app-phase01`. Edit with file tools only (Read/Edit/Write). No git worktrees, no junctions. Commit at the end of every task.
- **Precondition (parallel work):** another agent is changing `app/src/app/login/LoginForm.tsx` (fetch-based login), `app/src/app/api/auth/login/route.ts` (401 message), `app/capacitor.config.ts` (`backgroundColor`, `launchAutoHide: false`), `app/ios/App/App/Base.lproj/LaunchScreen.storyboard`, `app/ios/App/App/MainViewController.swift` (splash safety net), `app/src/lib/splash.ts`, `app/src/components/SplashReady.tsx`, `app/src/app/layout.tsx`, `app/src/app/globals.css` and `app/public/offline.html`. **Do not start Task 1 until `git status` shows none of these files modified or untracked and `git log` shows that agent's commit.** From then on, build on their version: the login is a JSON `fetch` with its own notice/shake UI, and the splash is hidden by the web app (`hideSplashScreen()`), with an 8 s native safety net. Keep their UI and behaviour; change only what a task names.
- **Next.js docs first:** every task that touches Next config, routing, proxy or pages starts by reading the named files under `app/node_modules/next/dist/docs/`. Verified facts this plan relies on (re-check if Next is upgraded):
  - `01-app/02-guides/static-exports.md`: under `output: "export"`, proxy, `headers()`, `redirects()`, `cookies()`, request-reading route handlers, dynamic routes without `generateStaticParams` and default image optimization are unsupported. Client components prerender at build time.
  - `next/dist/build/index.js:613-614`: proxy detection uses `config.pageExtensions`, so `pageExtensions: ["tsx"]` makes `src/proxy.ts` and every `route.ts` invisible to the mobile build. `03-api-reference/05-config/01-next-config-js/pageExtensions.md:43` states the same for proxy.
  - `next/dist/build/index.js:452-456`: with a custom export `distDir`, intermediates still go to `.next`. `:538`: `next build` cleans `.next` but keeps `cache`, `dev` and `lock`, so the dev server's `.next/dev` survives a mobile build in the dev checkout.
  - `03-api-reference/03-file-conventions/proxy.md:456-553`: CORS in the proxy, headers set on `NextResponse.next()` reach the route handler's response.
- **Capacitor facts:** `node_modules/@capacitor/ios/Capacitor/Capacitor/Router.swift:19-28`: the default router serves `/index.html` for EVERY extensionless path. `CAPBridgeViewController.swift:106`: `open func router() -> Router` can be overridden. CapacitorHttp stays disabled (it would break the streamed AI chat).
- **Single config values:**
  - `BUILD_TARGET=mobile` selects the export build. Unset means web.
  - `NEXT_PUBLIC_API_BASE_URL` is the only server address in the mobile build. It must be `https://…`, except `http://127.0.0.1:<port>` and `http://localhost:<port>` for local emulation. The production value is `https://desktop-7gu8ukj.tail42feb1.ts.net:8443`.
  - App client origin allowlist: env `MOBILE_APP_ORIGINS` (comma-separated), default `capacitor://localhost`. When `NODE_ENV !== "production"` the emulation origin `http://127.0.0.1:3210` is also allowed. Production never allows an `http:` origin.
- **Local verification harness (Windows, no Mac):**
  - Dev server: `http://127.0.0.1:3200` from `C:\Users\Hhusey\lashkirja\app` (`next dev`). It is already running; never stop or restart it. It hot-reloads code, including `proxy.ts`. Demo login: `demo@lashkirja.fi` / `demo123`. Never change the demo password.
  - Mobile build for emulation: `npm run build:mobile -- --api-base-url http://127.0.0.1:3200` (created in Task 4). Serve it: `npx tsx scripts/mobile/serve-export.ts` (port 3210, same path rules as the native router).
  - Browser checks: Playwright with the installed Chrome, `chromium.launch({ channel: "chrome" })`, iPhone 13 viewport on Chromium. The mobile suite is `playwright.mobile.config.ts` (Task 4). Scratch scripts go in the session scratchpad and are never committed.
  - Unit tests: `npm test`. Integration tests: `npm run test:integration`, which on Windows needs the shim: `NODE_OPTIONS="--require C:/Users/Hhusey/AppData/Local/Temp/claude/C--Users-Hhusey/26fedb5a-984d-4af0-ad71-2539bf3779d3/scratchpad/finalfix/npx-shell-shim.js"` (it forces `shell: true` for `execFileSync("npx")` in `tests/integration/global-setup.ts`). If that file is gone, recreate it in the scratchpad from `.superpowers/sdd/2026-09-28-real-app-phase01/task-1-2-report.md` context (13 lines: wrap `child_process.execFileSync`, add `shell: true` when the file is exactly `npx`). Never commit it.
  - `xcodebuild` runs only in GitHub Actions (`.github/workflows/build-ipa.yml`, macOS runner). Swift is compile-checked there.
- **Baselines (must not get worse):** lint 11 errors / 28 warnings. Unit tests: 5 Windows-only failures (backup-script 3, db-permissions 1, db-upgrade 1). Typecheck clean. Integration suite green.
- **CI parity:** before calling a task done, run every suite CI runs for the files you touched (`.github/workflows/ci.yml`: typecheck, unit, integration, web build, `test:e2e:ci`; from Task 4 on also the mobile export step). Enumerate from the workflow, not from `package.json` `test`.
- **Production:** never send real writes to production. The only production writes this plan allows are a login and logout of a session row in Task 13, and only with credentials the controller hands over. Never touch the Tailscale serve/funnel config. Deploy only through `app/scripts/ops/deploy-local.ps1`.
- **Third-party APIs:** before calling a newly installed package, probe the installed version (types in `node_modules/<pkg>/dist/*.d.ts`, `Package.swift` present for SPM, `peerDependencies` accepting `@capacitor/core ^8`). Record what you checked in the commit message body.
- **Copy:** user-visible text is Finnish, short, no em dashes. Code comments and docs in English.
- **Secrets:** never print tokens, cookies, `.env` values or passwords in logs, reports or commits.
- **Every commit ends with:**
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Dt441ofXM5z9eZZdckoQC9
  ```

## Decisions made in this plan (with reasons)

1. **Dynamic `[id]` routes become query-parameter routes on both targets:** `/laskut/lasku?id=…`, `/kuitit/kuitti?id=…`, `/asiakkaat/asiakas?id=…`, `/pankki/tapahtumat/tiliote?id=…`. Static export supports this with no tricks: every page is one real file, `next/link` prefetches it, and navigation stays client-side. The alternatives are worse. One placeholder shell per segment (`generateStaticParams` returning `_`) makes every detail open a full document load, because Next's client router 404s on the missing RSC payload. A hash or custom client router would fork navigation between targets. The web keeps old URLs working through `redirects()` (web target only).
2. **Bank OAuth and app links use the `lashkirja://` custom scheme, not universal links.** Universal links need `/.well-known/apple-app-site-association` on the default HTTPS port of the domain. Port 443 of `desktop-7gu8ukj.tail42feb1.ts.net` belongs to another project, and Apple does not fetch from non-default ports. They also need the Associated Domains entitlement in a signed provisioning profile, and today's IPA is unsigned. The scheme is already registered (`scripts/patch-ios-url-scheme.ts`) and survives a server move. Revisit universal links when the server has its own domain and the build is signed (Faz 3/4).

   **Residual risk, checked at the final review (final-review-security.md M5) and accepted:** a custom scheme like `lashkirja://` can be claimed by any other iOS app that also registers it - iOS has no ownership check for a custom scheme, unlike a universal link's domain-verified association file. Concretely, for the bank-return flow (`app/src/app/bank/callback/page.tsx`, `app/src/lib/bank-return.ts`):
   - **No open redirect.** The scheme and host are fixed (`lashkirja://bank/callback`); only the query string is carried over and `URLSearchParams.toString()` re-encodes it, so no `javascript:` or attribute break-out is reachable.
   - **The consent state is protected independently of the scheme.** It is bound to the user (`where: { userId, authStateHash }`), compared in constant time, single-use (`pending` → `authorizing` → `active`), and expires after 1 hour.
   - **A hijacked code is useless without LashKirja's private key.** Whichever app's URL handler wins the race receives the code and state, but redeeming the code requires Enable Banking's JWT, signed with LashKirja's private key. Injecting an attacker's code or state into the real app just ends in `STATE_MISMATCH`.
   - **The real residual risk is denial, not takeover:** if another app has also registered `lashkirja://`, the OS may hand the callback to that app instead of ours, and the consent is simply never completed - annoying, not exploitable.
   - **Revisit when:** universal links become possible (see above - a signed build with its own HTTPS domain), which removes the ambiguity entirely; or if Enable Banking adds PKCE, which would close even the denial case by binding the callback to a verifier only this app holds.

3. **Bearer token = an iron-sealed payload tied to the existing `AuthSession` row.** No schema migration. Revocation, "log out everywhere", password reset and account close work unchanged, because every check already goes through the row. The token lives 30 days and the app refreshes it after 7 days, so an app used at least monthly never asks for the password again.

   **Refresh hardening added at the final review (final-review-security.md I1/I3):** `/api/auth/token/refresh` now accepts a bearer credential only (never the web cookie - see `app/src/app/api/auth/token/refresh/route.ts`) and applies `rejectCrossSite`. Refresh is also refused once the `AuthSession` row is older than `MAX_AUTH_SESSION_AGE_MS` (90 days, same file) - chosen because it is longer than the "used at least monthly" refresh cadence above, so a real user is never forced back to a password login more than a few times a year, while a stolen token's usable life is bounded to a few months instead of forever. This needed no migration: `AuthSession.createdAt` already exists. What is still deferred (needs a migration, and was explicitly accepted as a residual risk by the review): real token rotation - a `tokenGeneration` column so a refresh invalidates the token just presented and a reused old token is detected as theft. Revisit alongside the App Store phase / signed build.
4. **The persistent cache is encrypted and exists only in the app.** AES-GCM with a key kept in the Keychain, and a crypto-shred (key and data deleted) on logout. The desktop web keeps its memory-only cache ("bookkeeping data has no business surviving in storage after the tab is closed", `src/lib/page-cache.ts:9-10`).
5. **An offline receipt photo becomes a pending receipt on the server** (the same "Tarkistettavat" queue email imports use), not an editor session. The owner does not have to stay on the screen while it uploads.
6. **App-origin requests never use cookies.** The server ignores the `Cookie` header when `Origin` is an app origin, so the CSRF origin check can pass app-origin requests safely. No `Access-Control-Allow-Credentials` anywhere.

## Deferred from spec (not in this plan)

- Moving the server off the home PC to a hosted EU server (roadmap Faz 4 last bullet). Only the URL changes then.
- Universal links (roadmap Faz 4, research §5.2). Replaced by the custom scheme, see decision 2.
- Signing, TestFlight, push, native crash reporting, privacy manifest (roadmap Faz 3). The IPA stays unsigned.
- A minimum-app-build gate and live JS updates (research §5.2 "Release"). This plan only adds an API version header and an "update the app" banner.
- Phase 2b "Apple feel" (motion, haptics, skeletons, optimistic UI). Only hooks: `src/lib/haptics.ts` already exists and the new code calls it where a later plan will want it (login success/failure already does).
- Deleting the now-unused remote-mode pieces (`public/offline.html`, `scripts/patch-ios-offline-server.ts`, `src/lib/ios-offline-server.ts`). They stay in place, harmless. Task 12 only stops calling the patch step.
- Enable Banking is disabled in production (`ENABLEBANKING_ENABLED=false`, task-3 report). The bank return is verified locally only.

## Screen coverage

| Screen | Change the owner can see |
|---|---|
| Login | None (the fetch login from the parallel agent). In the app it stores a token instead of a cookie. |
| Koti, Myynti, Kirjanpito, Raportit, Asetukset (roots) | Instant paint from cache. Offline banner under the header. Tabs prefetch. |
| Invoice, receipt, customer, statement details | New URLs (`?id=`). Same look. Files open through the share sheet in the app. |
| Kuitit, Kuitit / uusi | New "Odottaa lähetystä" card for queued photos. Offline capture goes to the queue. |
| Pankkitilit bank connect, `/bank/callback` | In the app the bank opens in an in-app browser and returns via `lashkirja://`. The web page gains a "Palaa LashKirjaan" state for app-started flows. |
| Password reset, email confirm (email links) | Still open the web version in Safari. The success state adds "Avaa LashKirja-sovellus" on iPhone. |
| All other screens | Unchanged, bundled. |

---

### Task 1: Bearer token auth on the server

**Files:**
- Create: `app/src/lib/auth-credential.ts`, `app/src/lib/auth-credential.test.ts`, `app/src/lib/auth-login.ts`, `app/src/app/api/auth/token/route.ts`, `app/src/app/api/auth/token/refresh/route.ts`, `app/tests/integration/bearer-token.test.ts`
- Modify: `app/src/lib/session-options.ts` (add `kind` to `SessionData`), `app/src/lib/session.ts` (`requireSession`), `app/src/app/api/auth/login/route.ts` (use `auth-login.ts`), `app/src/app/api/auth/logout/route.ts`, `app/src/app/api/auth/me/route.ts`, `app/src/app/api/auth/sessions/route.ts`, `app/src/app/api/auth/email/confirm/route.ts`, `app/src/lib/session-policy.ts` (`deviceLabel` app variant), `app/src/proxy.ts` (API gate reads bearer)

**Interfaces:**
- Produces (used by Tasks 2, 5, 13):

```ts
// src/lib/session-options.ts
export interface SessionData {
  userId?: string;
  email?: string;
  firstName?: string;
  sessionId?: string;
  /** "bearer" only inside a token. A cookie never carries it; a token always does. */
  kind?: "bearer";
}

// src/lib/auth-credential.ts  (no DB import: the proxy uses it)
export const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const TOKEN_REFRESH_AFTER_SECONDS = 7 * 24 * 60 * 60;
export type Credential =
  | { kind: "bearer"; data: SessionData & { userId: string; sessionId: string } }
  | { kind: "cookie"; data: SessionData & { userId: string } };
/** Authorization header wins. A malformed or failing bearer never falls back to the cookie.
 *  The cookie is ignored when the request Origin is an app client origin (Task 2 supplies
 *  isAppClientOrigin; until then pass a predicate that returns false). */
export async function readCredential(
  headers: Headers,
  cookieValue: string | undefined,
  isAppOrigin: (origin: string | null) => boolean
): Promise<Credential | null>;
export async function sealBearerToken(data: {
  userId: string; email: string; firstName: string; sessionId: string;
}): Promise<{ token: string; expiresAt: Date }>;
```

- Token HTTP contract (exact):

```
POST /api/auth/token
  Content-Type: application/json
  { "email": string, "password": string, "device"?: "ios-app" }
  200 { "token": string, "tokenType": "Bearer", "expiresAt": "<ISO>",
        "user": { "userId": string, "email": string, "firstName": string } }
  400 { "error": "Sähköposti ja salasana vaaditaan" }
  401 { "error": <byte-identical to the JSON 401 of /api/auth/login> }
  403 { "error": "Tilin käyttö on suljettu. Kirjanpitoaineisto säilyy säilytysajan." }
  429 { "error": "Liian monta kirjautumisyritystä. Yritä myöhemmin uudelleen." }  + Retry-After
  500 { "error": "Kirjautuminen epäonnistui" }
  Never sets a cookie. Same rate-limit buckets as /api/auth/login:
  login:ip:<clientKey> 20 / 15 min and login:account:<opaque(email)> 5 / 15 min.
  Unknown email and wrong password take the same bcrypt path (DUMMY hash) and return the same 401.

POST /api/auth/token/refresh
  Authorization: Bearer <token>
  200 same body as /api/auth/token, a new token for the SAME AuthSession row
  401 { "error": { "code": "UNAUTHORIZED", "message": "Kirjautuminen vaaditaan" } }
  Rate limit token-refresh:<sessionId> 30 / hour.

POST /api/auth/logout   with Authorization: Bearer  -> revokes that row, 200 { "ok": true }, no Set-Cookie
GET  /api/auth/me       with Authorization: Bearer  -> { "user": { userId, email, firstName } }
     email and firstName now come from the DB user row for both cookie and bearer callers.
```

- Token payload: `sealData({ userId, email, firstName, sessionId, kind: "bearer" }, { password: sessionOptions.password, ttl: TOKEN_TTL_SECONDS })`. `readCredential` rejects a bearer whose payload lacks `kind: "bearer"` or `sessionId`, and rejects a cookie whose payload has `kind: "bearer"`.

- [ ] **Read first:** `src/lib/session.ts`, `src/lib/session-options.ts`, `src/proxy.ts`, `src/app/api/auth/*/route.ts`, `src/lib/account-security.ts` (`openAuthSession`, `revokeAuthSessions`), `src/lib/rate-limit.ts`, `tests/integration/revoked-session-loop.test.ts`, `tests/integration/helpers/http.ts`.
- [ ] **`auth-login.ts`:** move `credentialsSchema`, `DUMMY_PASSWORD_HASH`, `authenticate()` and the rate-limit sequence out of `login/route.ts` into `export async function checkCredentials(req, email, password): Promise<{ ok: true; user } | { ok: false; status: 400 | 401 | 403 | 429; error: string; retryAfter?: number }>`. Keep the parallel agent's 401 wording exactly (read it from the file, do not retype it). `login/route.ts` keeps its form-POST and JSON branches and calls `checkCredentials`. `token/route.ts` calls it too and never touches `getIronSession`.
- [ ] **`requireSession(req?)`:** resolve the credential with `readCredential(req.headers, req.cookies.get(name)?.value, isAppOrigin)`. For the no-argument form (10 call sites) read `headers()` and `cookies()` from `next/headers`. The DB checks stay exactly as today (user `accessDisabledAt`, legacy cutoff, `authSession` row not revoked, `lastSeenAt` touch). For a bearer, return a plain object typed `AuthenticatedSession` whose `save()` and `destroy()` are no-ops and `updateConfig()` is a no-op. Extend the user `select` with `email` and `firstName` and expose them on the returned session so `/api/auth/me` can return DB values.
- [ ] **Logout, sessions, email confirm:** logout revokes the row named by the credential (bearer or cookie) and destroys the iron cookie only for cookie callers. `sessions` POST keeps `signedOut` in the body; it destroys the cookie only for cookie callers. `email/confirm` keeps `session.save()` (a no-op for bearer).
- [ ] **Device label:** `deviceLabel(ua, device?: "ios-app")` returns `"iPhone · LashKirja-sovellus"` for `device === "ios-app"`. The token route passes the body's `device` to `openAuthSession` (add an optional parameter there).
- [ ] **Proxy API gate:** replace the cookie-only `checkAuth(request, false)` in the `/api/` branch with `readCredential(request.headers, cookie, () => false)`. Keep `/api/auth/` public (so `/api/auth/token` and `/refresh` are reachable; refresh does its own check). Page routes are untouched. Keep the proxy DB-free on the API path.
- [ ] **Unit tests** (`auth-credential.test.ts`): a sealed bearer round-trips; a bearer without `kind` is rejected; a cookie with `kind: "bearer"` is rejected; `Authorization: Basic x` returns null and does not fall back to a valid cookie; an expired token (seal with `ttl: 1`, advance fake timers) is rejected.
- [ ] **Integration tests** (`bearer-token.test.ts`, route handlers called directly with `buildRequest`): token issue 200 has no `set-cookie`; wrong password and unknown email give byte-identical 401 bodies; the 6th wrong attempt for one email is 429 with `Retry-After`; `GET /api/dashboard` (any protected GET) with the bearer is 200 and without it 401; logout with the bearer revokes the row and the same token then gets 401 from `/api/auth/me` and from the proxy-gated route; `sessions` scope `all` from a cookie session also kills the bearer; refresh returns a token with the same `sessionId` and a later `expiresAt`; refresh of a revoked token is 401; `closeAccount`-style `accessDisabledAt` kills the bearer.
- [ ] **Verify on Windows:** `npm run typecheck`, `npm run lint` (baseline), `npm test` (baseline), integration suite with the shim (all green, new file included). Then against the dev server with a scratch Node script: `POST http://127.0.0.1:3200/api/auth/token` with the demo credentials → 200; `GET /api/auth/me` with the bearer → the demo user; logout with the bearer → the same token gets 401. Web login in Chrome on :3200 still lands on `/dashboard`.
- [ ] Commit: `feat(auth): bearer tokens tied to session rows, for the bundled app`

### Task 2: CORS, CSRF and API version for the app origin

**Files:**
- Create: `app/src/lib/app-origins.ts`, `app/src/lib/app-origins.test.ts`, `app/tests/integration/app-origin-cors.test.ts`
- Modify: `app/src/proxy.ts`, `app/src/proxy.test.ts`, `app/src/lib/http-security.ts`, `app/src/lib/http-security.test.ts`, `app/src/lib/session.ts` and `app/src/proxy.ts` (pass the real `isAppClientOrigin` into `readCredential`), `app/docs/ops-windows.md` (one paragraph: the API now serves the app origin; no `.env` change needed)

**Interfaces:**
- Produces:

```ts
// src/lib/app-origins.ts  (pure, no DB, no next/server)
export const API_VERSION = 1;
export const DEV_EMULATION_ORIGIN = "http://127.0.0.1:3210";
export function appClientOrigins(env?: NodeJS.ProcessEnv): string[];
export function isAppClientOrigin(origin: string | null, env?: NodeJS.ProcessEnv): boolean;
export function corsPreflightHeaders(origin: string): Record<string, string>;
export function corsResponseHeaders(origin: string): Record<string, string>;
```

- CORS rules (exact):

```
Allowed origins: MOBILE_APP_ORIGINS split on "," and trimmed, default "capacitor://localhost".
                 Plus DEV_EMULATION_ORIGIN only when NODE_ENV !== "production".
                 Exact string match. No wildcards. "null" is never allowed.

OPTIONS /api/* with allowed Origin (answered in the proxy, before any auth check):
  204, body empty
  Access-Control-Allow-Origin: <origin>
  Access-Control-Allow-Methods: GET, POST, PUT, PATCH, DELETE, OPTIONS
  Access-Control-Allow-Headers: Authorization, Content-Type, Idempotency-Key, Accept
  Access-Control-Max-Age: 600
  Vary: Origin
OPTIONS /api/* with any other Origin or none: 403 { "error": "Pyyntö estettiin" }, no Access-Control-* headers.

Any other /api/* response (including the proxy's own 401) when Origin is allowed:
  Access-Control-Allow-Origin: <origin>
  Access-Control-Expose-Headers: Retry-After, Content-Disposition, X-LashKirja-Api-Version
  Vary: Origin
Any /api/* response, whatever the Origin:
  X-LashKirja-Api-Version: 1
Never: Access-Control-Allow-Credentials. Never ACAO "*".

Cookie rule: when Origin is an allowed app origin, the Cookie header is ignored for authentication.
CSRF rule: rejectCrossSite(req) returns null (pass) when Origin is an allowed app origin
           (those requests carry no ambient credentials, see the cookie rule). All other
           behaviour of rejectCrossSite is unchanged.
```

- [ ] **Read first:** `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md` lines 456-553 (CORS), `src/lib/http-security.ts`, `src/proxy.ts`, `src/proxy.test.ts`.
- [ ] **Proxy order for `/api/*`:** (1) `OPTIONS` → preflight rules above and return; (2) auth gate from Task 1 with `isAppClientOrigin`; (3) on every return path (401 JSON, `NextResponse.next()`), add the response headers. Write a small `withApiHeaders(response, origin)` helper so no return path can miss it. The 401 must carry CORS headers, otherwise the app sees a network error instead of 401.
- [ ] **Flip-a-default check:** the proxy gains an early `OPTIONS` return. Add a proxy unit test per request category: OPTIONS allowed origin, OPTIONS foreign origin, public API with allowed origin, protected API with bearer, protected API with cookie from the web (no Origin), protected API with cookie plus app Origin (→ 401), page route (unchanged, no CORS headers).
- [ ] **Unit tests** (`app-origins.test.ts`): default list; env list trimming; the emulation origin allowed in development and refused with `NODE_ENV=production`; `http://capacitor.localhost`, `capacitor://localhost.evil`, `null` refused. `http-security.test.ts`: app origin with `sec-fetch-site: cross-site` passes; a foreign origin still gets 403.
- [ ] **Integration tests** (`app-origin-cors.test.ts`): through `proxy()` and a real route handler: a bearer `GET` with `Origin: capacitor://localhost` gets ACAO, expose headers and `X-LashKirja-Api-Version: 1`; a `POST /api/customers` (any guarded write) with bearer and app Origin passes `guardWrite`; the same POST with a cookie and a foreign Origin is 403 as before; `POST /api/auth/token` from the app origin passes `rejectCrossSite`.
- [ ] **Verify on Windows:** typecheck, lint, unit, integration (shim). Against :3200 from a scratch Node script: `OPTIONS /api/dashboard` with `Origin: http://127.0.0.1:3210` → 204 with the headers above; with `Origin: https://evil.example` → 403 without ACAO. In Chrome on :3200 the web app still logs in, opens all five roots and logs out (same-origin requests have no ACAO; check one response).
- [ ] Commit: `feat(api): CORS and CSRF rules for the app origin, API version header`

### Task 3: Query-parameter detail routes (both targets)

**Files:**
- Create: `app/src/lib/routes.ts`, `app/src/lib/routes.test.ts`, `app/src/app/laskut/lasku/page.tsx`, `app/src/app/kuitit/kuitti/page.tsx`, `app/src/app/asiakkaat/asiakas/page.tsx`, `app/src/app/pankki/tapahtumat/tiliote/page.tsx` (+ move `StatementDetailClient.tsx` next to it)
- Delete: `app/src/app/laskut/[id]/`, `app/src/app/kuitit/[id]/`, `app/src/app/asiakkaat/[id]/`, `app/src/app/pankki/tapahtumat/[id]/`
- Modify: every producer of a detail link (15 files today, list below), `app/src/lib/navigation.ts` (+ test), `app/src/lib/nav-direction.test.ts`, `app/next.config.ts` (web redirects), `app/src/next-config-redirects.test.ts`, `app/tests/e2e/*.spec.ts` and `app/tests/integration/*.test.ts` where they assert detail paths

**Interfaces:**
- Produces (used by Tasks 4, 9, 10, 11):

```ts
// src/lib/routes.ts
export type DetailKind = "invoice" | "receipt" | "customer" | "statement";
export const DETAIL_ROUTES: Record<DetailKind, string> = {
  invoice: "/laskut/lasku",
  receipt: "/kuitit/kuitti",
  customer: "/asiakkaat/asiakas",
  statement: "/pankki/tapahtumat/tiliote",
};
/** detailHref("invoice", "abc") === "/laskut/lasku?id=abc"; extra params are appended in insertion order. */
export function detailHref(kind: DetailKind, id: string, extra?: Record<string, string>): string;
/** "/laskut/abc?x=1" -> "/laskut/lasku?id=abc&x=1"; returns null for anything that is not a legacy detail path
 *  (static siblings such as "/laskut/uusi" and the new paths themselves are not legacy). */
export function normalizeLegacyDetailPath(href: string): string | null;
```

- [ ] **Read first:** `static-exports.md` (Unsupported Features), `03-api-reference/05-config/01-next-config-js/redirects.md` (regex params), `src/lib/navigation.ts`, each `[id]` page.
- [ ] **Pages:** each new page is a client module: `export default function Page() { return <Suspense fallback={<LoadingState …/>}><Detail /></Suspense> }`, where `Detail` reads `useSearchParams().get("id")`. Port the existing component body unchanged except `use(params)` / `useParams()` → the search param. A missing or empty `id` renders the page's existing not-found state. Keep every other search param the statement page already reads.
- [ ] **Sweep (producers):** replace every string-built detail path with `detailHref`. Today's list (re-grep `(laskut|kuitit|asiakkaat|tapahtumat)/\$\{` and `/:id` before starting): `components/BankConnectCard.tsx`, `components/ReceiptUploadArea.tsx`, `components/ReceiptEditor.tsx`, `app/pankki/taydennys/page.tsx`, `app/laskut/page.tsx`, `app/laskut/uusi/page.tsx`, `app/asiakkaat/page.tsx`, `app/kuitit/ReceiptRow.tsx`, `app/pankki/tapahtumat/TapahtumatClient.tsx`, the moved detail pages themselves, and the SERVER producers `lib/work-queue.ts` and `lib/period-precheck.ts` (their `href` goes out in API JSON). Also sweep prompts and copy (`src/lib/ai-assistant.ts`, `chat-*`) for detail paths, and every test config CI runs (`tests/e2e`, `tests/integration`, unit tests).
- [ ] **Consumers of server hrefs:** where the UI renders an `href` that came from the API (work queue, period precheck), pass it through `normalizeLegacyDetailPath(href) ?? href`, so an older server still yields working links.
- [ ] **Navigation:** `navigation.ts` detail entries use the new paths, `matchNav`/`backTarget`/`shellShowsBack` match on pathname only (query ignored). Update `navigation.test.ts` and `nav-direction.test.ts` expectations.
- [ ] **Web redirects** (`next.config.ts`, web target only; Task 4 adds the target switch): for each parent, `source: "/laskut/:id((?!uusi$|lasku$)[^/]+)"` → `destination: "/laskut/lasku?id=:id"`, 307. Build the negative lookahead from the static child folders that exist under that parent at implementation time (list them with Glob; today `laskut/uusi`, `kuitit/uusi`). Point the legacy `/tiliotteet/:id` redirect straight to `/pankki/tapahtumat/tiliote?id=:id`. Update `next-config-redirects.test.ts`.
- [ ] **Verify on Windows:** typecheck, lint, unit, integration (shim), `npm run build` (web; the build output now lists the four detail routes as static `○`). Playwright on :3200 (Chrome, iPhone 13): log in; open one invoice, one receipt, one customer and one statement from their lists; each shows its h1 and the URL has `?id=`; back returns to the list; open `/laskut/<a real id>` directly → redirected to the new URL; `/laskut/uusi` still opens the new-invoice form (not redirected).
- [ ] Commit: `refactor(routes): detail pages read ?id= so both targets can be static`

### Task 4: Mobile build target and static export

**Files:**
- Create: `app/src/lib/build-target.ts`, `app/src/lib/export-path.ts`, `app/src/lib/export-path.test.ts`, `app/scripts/build-mobile.ts`, `app/scripts/mobile/serve-export.ts`, `app/playwright.mobile.config.ts`, `app/tests/e2e-mobile/boot.spec.ts`, `app/src/components/BootRedirect.tsx`
- Modify: `app/next.config.ts`, `app/package.json` (scripts), `app/src/app/page.tsx`, `app/src/app/dashboard/page.tsx`, `app/src/app/layout.tsx` (CSP meta for mobile), `app/src/proxy.ts` (+ test: authenticated `/` → 307 `/dashboard`), `.github/workflows/ci.yml` (mobile export step), `app/.gitignore` (nothing: `/out/` is already ignored; confirm)

**Interfaces:**
- Produces:

```ts
// src/lib/build-target.ts
export const IS_MOBILE_BUILD: boolean;            // process.env.NEXT_PUBLIC_BUILD_TARGET === "mobile"
export const API_BASE_URL: string;                 // "" on web; NEXT_PUBLIC_API_BASE_URL without trailing slash on mobile
export function apiUrl(path: string): string;      // "/api/x" -> API_BASE_URL + "/api/x"; any other input returned unchanged

// src/lib/export-path.ts  (the native router in Task 12 is a Swift port of this)
/** Maps a request pathname to the file to serve from the export root.
 *  - has an extension: served as is
 *  - "/" or "": "/index.html"
 *  - "/a/b" or "/a/b/": "/a/b.html" if it exists, else "/a/b/index.html" if it exists, else "/index.html" */
export function resolveExportPath(pathname: string, exists: (relativePath: string) => boolean): string;
```

- `npm run build:mobile -- --api-base-url <url>`: validates the URL (https, or http on 127.0.0.1/localhost), runs `next build` with `BUILD_TARGET=mobile`, `NEXT_PUBLIC_BUILD_TARGET=mobile`, `NEXT_PUBLIC_API_BASE_URL=<url>`, then asserts `out/index.html`, `out/login.html`, `out/dashboard.html`, `out/laskut/lasku.html`, `out/_next/static/` exist, that no file under `out/` is named `route*` or contains `/api/` route handler output, and that the API base URL string appears in at least one `out/_next/static/**/*.js`. Prints the total size of `out/`.

- [ ] **Read first:** `static-exports.md`, `output.md`, `pageExtensions.md`, `trailingSlash.md`, `02-guides/content-security-policy.md`.
- [ ] **`next.config.ts`:** when `process.env.BUILD_TARGET === "mobile"`: `output: "export"`, `pageExtensions: ["tsx"]`, `trailingSlash: false`, `images: { unoptimized: true }`, no `headers()` and no `redirects()` keys at all, `env` adds `NEXT_PUBLIC_BUILD_TARGET: "mobile"` and `NEXT_PUBLIC_API_BASE_URL`. Throw at config load if `NEXT_PUBLIC_API_BASE_URL` is missing or fails the URL rule. The web branch stays byte-for-byte what it is today plus Task 3's redirects.
- [ ] **Probe the export** before fixing anything: run `npm run build:mobile -- --api-base-url http://127.0.0.1:3200` once and record every build error. Expected blockers after Task 3: `src/app/page.tsx` and `src/app/dashboard/page.tsx` (`cookies()`). If `proxy.ts` or a `route.ts` is still picked up, stop and report: the `pageExtensions` mechanism is the plan's hypothesis (verified in source, not yet by a build).
- [ ] **`/` and `/dashboard`:** `page.tsx` renders `<BootRedirect />`, a client component: web → `router.replace("/dashboard")`; mobile → waits for the boot result (Task 5 provides it; until then treat as signed out) and `router.replace` to `/dashboard` or `/login`. `dashboard/page.tsx` becomes `export default function DashboardPage() { return <DashboardClient /> }`; `DashboardClient` takes `firstName` from the session source (Task 6); until Task 6 lands, read it from `readPageCache("shell-auth")`. Proxy: an authenticated `/` redirects to `/dashboard` (keeps the web one hop shorter). Add the proxy test.
- [ ] **CSP in the mobile build:** `layout.tsx` renders `<meta httpEquiv="Content-Security-Policy" content=…>` only when `IS_MOBILE_BUILD`: `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' <API origin>; object-src 'none'; base-uri 'self'; form-action 'none'`. (`frame-ancestors` is not allowed in a meta tag.)
- [ ] **Serve script:** `scripts/mobile/serve-export.ts` (Node `http`, no new dependency), `--port 3210 --root out`, uses `resolveExportPath`, content types by extension, `Cache-Control: no-cache` (what Capacitor sends). Unit-test `resolveExportPath` with a fake `exists`.
- [ ] **Mobile Playwright config:** `playwright.mobile.config.ts`: `testDir: "./tests/e2e-mobile"`, Chromium with `channel: "chrome"`, iPhone 13 viewport/touch/UA on Chromium, `baseURL: "http://127.0.0.1:3210"`, `webServer: { command: "npx tsx scripts/mobile/serve-export.ts", url: "http://127.0.0.1:3210", reuseExistingServer: true }`, no managed Next server (the dev server on :3200 is the API). `package.json`: `"build:mobile": "tsx scripts/build-mobile.ts"`, `"test:e2e:mobile": "playwright test -c playwright.mobile.config.ts"`.
- [ ] **CI:** in `ci.yml` job `check`, add a step "Mobile static export" BEFORE "Production build": `npm run build:mobile -- --api-base-url https://api.example.invalid`. It must precede the web build, because both write `.next` and the e2e step needs the web build.
- [ ] **Verify on Windows:** typecheck, lint, unit, integration (shim), web `npm run build`, then `npm run build:mobile -- --api-base-url http://127.0.0.1:3200` (passes its own assertions; note the `out/` size in the commit body), then `npm run test:e2e:mobile` with `boot.spec.ts`: `/` lands on `/login` and the login h1 is visible; loading `http://127.0.0.1:3210/laskut/lasku?id=x` directly serves `laskut/lasku.html` (not index); no console CSP violations. The dev server on :3200 still answers after the mobile build (its `.next/dev` survives).
- [ ] Commit: `feat(build): mobile static-export target behind BUILD_TARGET=mobile`

### Task 5: API client and the mobile auth flow

**Files:**
- Create: `app/src/lib/mobile/secure-store.ts`, `app/src/lib/auth-client.ts`, `app/src/lib/auth-client.test.ts`, `app/src/lib/app-nav.ts`, `app/src/components/NavBridge.tsx`, `app/src/lib/mobile/boot.ts`, `app/tests/e2e-mobile/auth.spec.ts`
- Modify: `app/package.json` (+ `@aparajita/capacitor-secure-storage`), `app/src/components/clientFetch.ts`, `app/src/components/clientFetch.test.ts`, `app/src/app/login/LoginForm.tsx` (only the request and the success branch), `app/src/components/AiChatDrawer.tsx` (the raw `fetch`), `app/src/components/ShellGate.tsx`, `app/src/app/layout.tsx` (mount `NavBridge`), `app/src/components/BootRedirect.tsx`

**Interfaces:**
- Consumes: Task 1 token contract, Task 2 CORS, Task 4 `IS_MOBILE_BUILD`, `apiUrl`.
- Produces:

```ts
// src/lib/mobile/secure-store.ts
export interface SecureStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}
/** Native: Keychain via the plugin. Not native AND hostname 127.0.0.1/localhost: localStorage under
 *  "lashkirja.emu." (emulation only). Anything else: memory only. */
export function secureStore(): SecureStore;
export const SECURE_KEYS = { auth: "lashkirja.auth.v1", cacheKey: "lashkirja.cachekey.v1", pendingRevoke: "lashkirja.pending-revoke.v1" } as const;

// src/lib/auth-client.ts
export interface StoredAuth { token: string; expiresAt: string; issuedAt: string; userId: string }
export type SignInResult =
  | { ok: true; user: { userId: string; email: string; firstName: string } }
  | { ok: false; status: number; error: string; retryAfter?: number };
export function getAccessToken(): string | null;                // sync, memory copy after boot
export async function loadStoredAuth(): Promise<StoredAuth | null>;
export async function signIn(input: { email: string; password: string; next?: string }): Promise<SignInResult>;
export async function signOutThisDevice(): Promise<boolean>;    // mobile logout
export function expireSession(): void;                          // mobile 401 path, once per signed-in period
export async function refreshTokenIfDue(now?: number): Promise<void>;
export function onAuthChange(listener: (auth: StoredAuth | null) => void): () => void;

// src/lib/app-nav.ts
export function setAppRouter(router: { push(h: string): void; replace(h: string): void } | null): void;
/** Mobile: client-side router navigation. Web: location.assign/replace (today's behaviour). */
export function appNavigate(path: string, options?: { replace?: boolean }): void;

// src/lib/mobile/boot.ts
export interface BootResult { signedIn: boolean; userId: string | null }
export function bootMobile(): Promise<BootResult>;   // memoized; resolves in one pass per app launch
```

- [ ] **Probe the plugin:** `npm view @aparajita/capacitor-secure-storage version peerDependencies`; install the newest version whose peer range accepts `@capacitor/core ^8`; confirm `node_modules/@aparajita/capacitor-secure-storage/Package.swift` exists (SPM) and read its `.d.ts` for `get/set/remove` names and whether it exposes a Keychain accessibility option (use "after first unlock, this device only" if it does). **If no Capacitor 8 release exists**, write a local Keychain plugin instead: `KeychainStorePlugin` (Swift, `CAPBridgedPlugin`, methods `get/set/remove`, `kSecClassGenericPassword`, service `fi.tiyouba.lashkirja`, accessibility `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`) inside the existing `ios/App/App/MainViewController.swift` (adding a new Swift file would need a `project.pbxproj` edit), registered in `capacitorDidLoad()` with `bridge?.registerPluginInstance(...)`, and `registerPlugin("KeychainStore")` on the JS side. It is compile-checked in Task 12's CI run.
- [ ] **`clientFetch.ts`:** in `apiFetchAttempt`, when `IS_MOBILE_BUILD` and the URL starts with `/api/`: fetch `apiUrl(path)`, force `credentials: "omit"`, add `Authorization: Bearer <getAccessToken()>` when a token exists (merge with the caller's headers, whatever their shape). Export `authorizedFetch(input, init)` (same URL and header rules, no retry, no timeout) for streaming. Web behaviour unchanged (add a test that the web path passes the URL through untouched). `redirectToLogin()`: mobile → `expireSession()`. `leaveAfterSignOut()`: mobile → `signOutThisDevice()` then `appNavigate("/login", { replace: true })`, resolve `true`; the web branch stays exactly as phase 1 left it (single `location.replace`, `pagehide` watch).
- [ ] **Auth client rules:**
  - `signIn` on web: `POST /api/auth/login` JSON (what the form does today). On mobile: `POST apiUrl("/api/auth/token")` with `device: "ios-app"`, store `StoredAuth` in the secure store, keep the token in memory, notify listeners, reset the one-redirect guard.
  - `signOutThisDevice`: `POST /api/auth/logout` with the bearer (8 s timeout). Whatever the result: remove the stored auth, clear page cache and drafts (and, from Task 7, the persistent cache and its key). If the server call failed, store the token under `pendingRevoke` and retry that logout on the next successful request or app launch, then delete it.
  - `expireSession`: once per signed-in period: clear everything like logout (no server call), `appNavigate("/login?error=expired", { replace: true })`.
  - `refreshTokenIfDue`: when `now - issuedAt > TOKEN_REFRESH_AFTER_SECONDS`, call `/api/auth/token/refresh`; 401 → `expireSession()`; network error → keep the old token.
- [ ] **Login form:** replace only the `fetch("/api/auth/login", …)` block and the `response.ok` branch with `signIn()`, mapping `SignInResult` onto the existing status handling (401 shake, 429 `retryAfter`, other → message, thrown → "Ei yhteyttä palvelimeen…"). On success keep their haptic and `router.push(next || "/dashboard")`. On mobile, a signed-in user who lands on `/login` is replaced to `/dashboard`.
- [ ] **No document navigations on mobile:** `ShellGate` bank deep link uses `appNavigate`; `BootRedirect` uses `bootMobile()`; grep `location\.(assign|replace|reload|href\s*=)` across `src/` and route every in-app one through `appNavigate` on mobile (leave external URLs and the web branch alone).
- [ ] **`AiChatDrawer`:** the raw `fetch("/api/ai/chat")` becomes `authorizedFetch("/api/ai/chat", …)` so the stream keeps working cross-origin.
- [ ] **Unit tests:** header merge (plain object, `Headers`, array), `credentials` forced to omit on mobile, token absent → no header, `expireSession` fires navigation once until the next `signIn`, `refreshTokenIfDue` timing, pending-revoke retry. Mock the secure store and `fetch`.
- [ ] **Verify on Windows:** typecheck, lint, unit, integration (shim), web build, mobile build (`--api-base-url http://127.0.0.1:3200`), then `auth.spec.ts` on :3210: log in with the demo account → `/dashboard` renders real data (network shows `Authorization` on `/api/*` and no `Cookie`); reload the page → still signed in (token from emulation store); log out from the profile sheet → `/login` with no document navigation (assert `page.on("framenavigated")` fires no main-frame load); log in again; from a scratch script, revoke only this token's own row (`GET /api/auth/sessions` with the bearer to find the `current` row, then `POST /api/auth/sessions { "id": <that id> }`; never use scope `all` on the demo user) → the next API call in the page lands on `/login?error=expired` exactly once. Web regression on :3200: login, the five roots, logout.
- [ ] Commit: `feat(mobile): token login in the Keychain, API base URL, no document navigations`

### Task 6: One session source and a shell that does not wait (A1, A2, A3, A4, A7)

**Files:**
- Create: `app/src/components/SessionProvider.tsx`, `app/src/lib/session-state.ts` (pure: initial state per target, the shared `/me` promise, transitions on 200/401/network error), `app/src/lib/session-state.test.ts` (Vitest only runs `src/**/*.test.ts` in Node, so there are no component tests; keep the logic in the pure module)
- Modify: `app/src/components/AppShell.tsx`, `app/src/components/AppLock.tsx`, `app/src/components/ShellGate.tsx`, `app/src/app/dashboard/DashboardClient.tsx`, `app/src/app/asetukset/useAccountId.ts` (if it fetches `/me`), `app/docs/perf-budgets.md`

**Interfaces:**
- Produces:

```ts
export type SessionStatus = "unknown" | "signed-in" | "signed-out";
export interface ShellUser { userId?: string; email?: string; firstName?: string }
export interface SessionValue {
  status: SessionStatus;
  user: ShellUser | null;
  /** One shared GET /api/auth/me; concurrent callers share the promise. */
  refresh(): Promise<void>;
}
export function SessionProvider(props: { children: React.ReactNode }): JSX.Element;
export function useSession(): SessionValue;
```

- [ ] **Read first:** research §2.3 A1 to A4 and A7 rows, `AppShell.tsx:81-134, 355-430, 458-617`, `AppLock.tsx:80-115`.
- [ ] **Session source:** mounted once by `ShellGate` around `AppShell`. Initial state: web → `signed-in` (the proxy only serves a protected page to an unsealable cookie); mobile → from `bootMobile()` (signed-in when a token exists). `user` starts from the `shell-auth` page-cache entry. It fetches `/api/auth/me` once on mount and on `visibilitychange` to visible (the existing resume check). A 401 → `redirectToLogin()` (web) / `expireSession()` (mobile). A network error keeps the state.
- [ ] **A1:** `AppShell` renders `children` immediately whenever `status !== "signed-out"`. Remove the "Tarkistetaan istuntoa…" branch and the auth error screen. Page fetches now start in parallel with `/me`. Header initials and the onboarding check wait for `user` only.
- [ ] **A2:** `AppLock` takes `userId` from `useSession()`; its own `/api/auth/me` call goes away. `DashboardClient` takes `firstName` from `useSession()`.
- [ ] **A3:** `warmTabCaches()` no longer runs on mobile. On the web it runs once per document, in `requestIdleCallback` (fallback `setTimeout(…, 1500)`) after the first page's data, and only for keys missing from the cache (keep its "never overwrite" rule).
- [ ] **A4:** tab bar and sidebar root items become `<Link href prefetch>`; `onClick` keeps haptics and `armNavigation(href, "tab")`; when `anyFormDirty()` it calls `preventDefault()` and routes through `requestLeave` → `router.push`. Keep classes, `aria-current` and the active-press feedback.
- [ ] **A7:** web login already navigates client-side (parallel agent). Logout and 401 stay single full navigations on the web (phase 1 fix); on mobile they are client-side (Task 5). Nothing else to do; state this in the commit body.
- [ ] **Verify on Windows:** typecheck, lint, unit, integration (shim). Playwright on :3200 (web, Chrome, CDP throttle 150 ms RTT, 1.5 MB/s, 4× CPU): full load of `/kirjanpito` → the page's first `/api/*` data request starts before the `/api/auth/me` response ends; exactly one `/api/auth/me` per full load; no warm-up requests before the page's own data; a tab tap after 2 s idle issues no RSC fetch (prefetched). Record full-load and tab-switch medians (n ≥ 10) in `app/docs/perf-budgets.md` next to the research numbers. Mobile (:3210): dashboard renders without the checking screen; logout/login still pass `auth.spec.ts`.
- [ ] Commit: `perf(shell): one session source, render without waiting, prefetched tabs`

### Task 7: Persistent encrypted cache and instant launch (A6)

**Files:**
- Create: `app/src/lib/offline/idb.ts`, `app/src/lib/offline/crypto-box.ts`, `app/src/lib/offline/crypto-box.test.ts`, `app/src/lib/offline/persistent-cache.ts`, `app/src/lib/offline/persistent-cache.test.ts`, `app/src/lib/offline/http-cache.ts`, `app/src/lib/offline/http-cache.test.ts`, `app/tests/e2e-mobile/cache.spec.ts`
- Modify: `app/src/lib/page-cache.ts` (+ test), `app/src/components/clientFetch.ts`, `app/src/lib/mobile/boot.ts`, `app/src/lib/auth-client.ts` (wipe on logout/expire/user switch), `app/src/components/SplashReady.tsx` and `app/src/lib/splash.ts` (mobile: hide on first real screen), `app/src/components/AppShell.tsx` and `app/src/app/login/LoginForm.tsx` (call `markFirstScreen()` after first paint)

**Interfaces:**
- Produces (cache interface, exact):

```ts
// src/lib/offline/persistent-cache.ts
export interface CacheRecord<T = unknown> {
  key: string;          // "page:<screen key>" or "http:<path+query>"
  userId: string;       // owner; a different signed-in user never reads it
  fetchedAt: number;    // epoch ms of the successful network response
  value: T;
}
export interface PersistentCache {
  get<T>(key: string): Promise<CacheRecord<T> | null>;
  set<T>(key: string, value: T, fetchedAt?: number): Promise<void>;
  delete(key: string): Promise<void>;
  deletePrefix(prefix: string): Promise<void>;
  entries(prefix: string): Promise<CacheRecord[]>;   // boot hydration
  clear(): Promise<void>;                             // logout, expiry, user switch
}
/** null when IndexedDB or crypto.subtle is unavailable: callers fall back to memory only. */
export async function openPersistentCache(userId: string): Promise<PersistentCache | null>;

export const PERSISTENT_LIMITS = {
  pageEntries: 80,
  httpEntries: 300,
  httpBodyMaxBytes: 512 * 1024,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
} as const;

// IndexedDB: database "lashkirja-offline", version 1
//   store "cache": keyPath "key"; value { key, userId, fetchedAt, iv: Uint8Array, data: ArrayBuffer }
//   store "receipt-queue": created here, used by Task 10 (keyPath "id", index "userId")
// Encryption: AES-GCM 256, key = raw 32 bytes (base64) at SECURE_KEYS.cacheKey, imported non-extractable;
//   new random 12-byte IV per record; plaintext = JSON.stringify(value).

// src/lib/page-cache.ts additions
export function configurePageCachePersistence(store: PersistentCache | null, ttlMs: number, maxEntries: number): void;
export function hydratePageCache(records: CacheRecord[]): void;

// src/lib/offline/http-cache.ts
export function isCacheableGet(url: string, response: Response): boolean;
export async function rememberGet(url: string, response: Response): Promise<void>;
/** A Response rebuilt from the cache with headers X-LashKirja-Cache: stale and X-LashKirja-Fetched-At: <ISO>. */
export async function staleResponseFor(url: string): Promise<Response | null>;
```

- [ ] **Rules:**
  - Mobile only. `configurePageCachePersistence` is never called on the web, and every web path stays memory-only with the 5 min TTL.
  - Mobile page-cache: TTL 30 days, 80 entries. `writePageCache` writes through (fire and forget). `clearPageCache`, `clearPageCachePrefix` and `invalidateForMutation` also delete persistently. Pages already repaint from the network after every cache paint, so a long TTL only means "show the last copy until the fresh one arrives". The screens already show `pageCacheFetchedAt`.
  - HTTP cache: `isCacheableGet` = GET, status 200, `content-type` JSON, path under `/api/` and not under `/api/auth/`, `/api/jobs/`, `/api/health`, `/api/observe`, body ≤ 512 KB. It is used ONLY as a fallback when the network attempt fails (thrown `TypeError`, `ApiTimeoutError`, `ApiGatewayError` after retries) or when Task 8 already knows the device is offline. It never short-circuits a working network.
  - Boot (`bootMobile`): read auth; if signed in, open the cache for that `userId` and hydrate `page:` records within a 250 ms budget (continue without if it takes longer); if the stored `userId` differs from the cache owner, `clear()` first.
  - Wipe: logout, `expireSession`, user switch: `clear()` and remove `SECURE_KEYS.cacheKey` (crypto-shred).
  - Unavailable (`openPersistentCache` returns null): log once to `/api/observe` with event `offline_cache_unavailable` and continue memory-only. **Device check (owner, after Task 13):** confirm `crypto.subtle` exists on `capacitor://localhost` in WKWebView. If it does not, the app still works without the instant cache.
- [ ] **Splash:** in the mobile build, `SplashReady` no longer hides on layout mount; `markFirstScreen()` (new export in `splash.ts`) hides it, called after two rAFs by `AppShell` once children render and by `LoginForm` on mount. The native 8 s safety net stays. Web behaviour unchanged.
- [ ] **Unit tests:** crypto-box round trip and tamper rejection (Node `globalThis.crypto.subtle`); `PersistentCache` logic against an in-memory `IdbLike` adapter (limits, LRU by `fetchedAt`, max-age drop, prefix delete, userId isolation); page-cache write-through and invalidation mirror; `isCacheableGet` table; `staleResponseFor` headers. The real IndexedDB adapter is exercised in Playwright (no new dev dependency).
- [ ] **Verify on Windows:** typecheck, lint, unit, integration (shim), mobile build. `cache.spec.ts` on :3210: log in, open Koti, Kuitit and one invoice; close the context's page and open a new page in the same context (same IndexedDB) → Koti paints its numbers before any `/api/dashboard` response (block the route for 3 s and assert the value is on screen); then set the context offline → Kuitit and the same invoice still render with a "Päivitetty …" stamp; an invoice never opened shows the offline error state, not a spinner. IndexedDB contents are not readable JSON (spot-check one record in `page.evaluate`). Logout → the database has no `cache` records and the emulated key entry is gone.
- [ ] Commit: `feat(offline): encrypted persistent cache and instant launch in the app`

### Task 8: Connectivity: offline banner, fail-fast writes, version banner

**Files:**
- Create: `app/src/lib/connectivity.ts`, `app/src/lib/connectivity.test.ts`, `app/src/components/ConnectivityBanner.tsx`, `app/tests/e2e-mobile/offline.spec.ts`
- Modify: `app/package.json` (+ `@capacitor/network`), `app/src/components/clientFetch.ts` (report outcomes, fail fast, read `X-LashKirja-Api-Version`), `app/src/components/AppShell.tsx` and `app/src/app/login/LoginForm.tsx` (render the banner), `app/src/components/BuildInfo.tsx` (mobile only: `"Sovellus: paketoitu"`, the API host, and `"Välimuisti: salattu"` or `"Välimuisti: vain muistissa"` from Task 7's `openPersistentCache` result; the owner reads this line on the device in Task 13)

**Interfaces:**
- Produces:

```ts
export type DeviceState = "online" | "offline";
export type ServerState = "ok" | "unreachable";
export interface Connectivity { device: DeviceState; server: ServerState; lastOkAt: number | null; serverApiVersion: number | null }
export function useConnectivity(): Connectivity;
export function reportRequestOutcome(outcome: "ok" | "network-error", apiVersion?: number | null): void;
export class OfflineError extends Error {}   // name "OfflineError"
export function assertCanWrite(): void;      // throws OfflineError when device offline or server unreachable
```

- [ ] **Probe** `@capacitor/network` (Cap 8 peer, `Package.swift`, `addListener("networkStatusChange")`, `getStatus()`), install it.
- [ ] **State machine:** device state from `navigator.onLine` + `online`/`offline` events, and on native from the Network plugin. Server state: two consecutive network errors (thrown fetch, timeout, 502/503/504) → `unreachable`; any HTTP response from the API → `ok`. While `unreachable` and the document is visible, probe `GET apiUrl("/api/health")` every 15 s; any HTTP status (production answers 401 without the health token) counts as reachable. Web uses the same store (the banner is useful there too).
- [ ] **Writes:** `apiFetch` calls `assertCanWrite()` before any non-GET (except requests flagged `{ offlineQueue: true }`, used by Task 10). Messages, used verbatim:
  - device offline: `"Ei verkkoyhteyttä. Tämä toiminto vaatii yhteyden. Yritä uudelleen, kun yhteys palaa."`
  - server unreachable: `"Palvelimeen ei saada yhteyttä. Tämä toiminto vaatii yhteyden. Yritä hetken kuluttua uudelleen."`
  `errorMessage()` already shows `error.message`, so buttons and forms surface it with no per-page change. Check three write screens by hand (receipt save, invoice payment, settings profile) to confirm the message appears and the button leaves its busy state.
- [ ] **Banner** (below the header, above page content, `role="status"`, no layout jump for the tab bar):
  - offline: `"Ei verkkoyhteyttä. Näytetään viimeksi haetut tiedot."`
  - unreachable: `"Palvelimeen ei saada yhteyttä. Näytetään viimeksi haetut tiedot."`
  - when `serverApiVersion > API_VERSION`: `"LashKirjasta on uudempi versio. Päivitä sovellus."` (info tone, mobile only)
  - reconnect: on the transition back to ok, trigger `SessionProvider.refresh()` and dispatch a `lashkirja-reconnected` event pages may use; the banner disappears.
- [ ] **Unit tests:** state transitions table, probe scheduling with fake timers, `assertCanWrite` messages, version compare.
- [ ] **Verify on Windows:** typecheck, lint, unit, integration (shim), mobile build. `offline.spec.ts` on :3210: signed in, `context.setOffline(true)` → banner text appears within 1 s; tap save on a receipt edit → the offline message shows within 1 s and the button is enabled again; `setOffline(false)` → banner gone within 2 s and data refreshes. Server-unreachable: route `http://127.0.0.1:3200/api/**` to `abort("connectionrefused")` → banner shows the server text after two requests; unroute → recovers by the next probe. Web (:3200): the same offline check shows the banner.
- [ ] Commit: `feat(offline): connectivity banner, writes fail fast without a connection`

### Task 9: Files through authenticated fetch and the share sheet

**Files:**
- Create: `app/src/lib/authed-file.ts`, `app/src/lib/authed-file.test.ts`, `app/src/components/AuthedFileLink.tsx`, `app/tests/e2e-mobile/files.spec.ts`
- Modify: `app/src/components/ReceiptPreview.tsx`, `app/src/app/laskut/lasku/page.tsx` (PDF open at old line ~545, reminder PDF link ~730, share `url`), `app/src/app/raportit/page.tsx` (export package and `DownloadRow`), `app/src/app/asetukset/tietosuoja/page.tsx` (package link), `app/src/lib/share.ts` (only if a helper is missing)

**Interfaces:**
- Produces:

```ts
export function fileNameFromDisposition(header: string | null, fallback: string): string;
export async function fetchAuthedFile(path: string, fallbackName: string): Promise<File>;
/** Web: window.open(path) (cookie auth, today's behaviour). Mobile: fetch -> File -> shareContent({ file }). */
export async function openAuthedFile(path: string, fallbackName: string, title: string): Promise<ShareResult>;
/** Web: returns path unchanged. Mobile: fetches the bytes with the bearer, returns an object URL, revokes it on change/unmount. */
export function useAuthedObjectUrl(path: string | null): { src: string | null; failed: boolean };
export function AuthedFileLink(props: { href: string; fallbackName: string; title: string; className?: string; children: React.ReactNode }): JSX.Element;
```

- [ ] **Sites** (re-grep `href=\{?[\`"']/api/`, `window.open(`, `src=\{` with `/api/` before starting): `asetukset/tietosuoja/page.tsx` package link, `laskut/lasku` PDF menu item and reminder PDF link, `raportit/page.tsx` export package and each `DownloadRow`, `ReceiptPreview` `<img src>` and its two "Avaa…" links. `ReceiptEditor` keeps passing API paths to `ReceiptPreview`. `shareInvoice` drops `url: window.location.href` on mobile (a `capacitor://` URL means nothing to the recipient).
- [ ] **Behaviour:** a download on mobile opens the iOS share sheet with the real file name (Content-Disposition, exposed in Task 2); cancelling is silent. Offline or unreachable → `"Tiedosto ei ole saatavilla ilman yhteyttä."` Files are never put in the persistent cache.
- [ ] **Unit tests:** `fileNameFromDisposition` (quoted, `filename*=UTF-8''…`, missing → fallback), `openAuthedFile` branches with an injected share runtime (existing seam in `share.ts`).
- [ ] **Verify on Windows:** typecheck, lint, unit, integration (shim), web build, mobile build. `files.spec.ts` on :3210 (Chrome has no Capacitor share, so the web-share/download fallback runs; assert on the download event): open a receipt with an image → `<img>` has a `blob:` src and is visible; download a report CSV → the download has the server's file name; the invoice PDF action downloads a `%PDF` file. Check no `/api/` request goes out without `Authorization`. Web (:3200): the same links still work with cookies.
- [ ] Commit: `feat(files): authenticated file fetches and the native share sheet`

### Task 10: Offline receipt-photo queue

**Files:**
- Create (server): `app/src/app/api/receipts/inbox/route.ts`, `app/src/lib/receipt-inbox.ts`, `app/tests/integration/receipt-inbox.test.ts`
- Create (client): `app/src/lib/offline/receipt-queue.ts`, `app/src/lib/offline/receipt-queue.test.ts`, `app/src/components/useOfflineReceiptQueue.ts`, `app/src/components/QueuedReceiptsCard.tsx`, `app/tests/e2e-mobile/receipt-queue.spec.ts`
- Modify: `app/src/lib/document-jobs.ts` (payload `inbox` flag, pending receipt on done/failed), `app/src/app/api/receipts/route.ts` (extract the staging helpers it shares), `app/src/components/ReceiptUploadArea.tsx` / `app/src/app/kuitit/uusi/page.tsx` (offline capture path), `app/src/app/kuitit/page.tsx` (render the card), `app/src/components/AppShell.tsx` (queue driver + logout confirmation), `app/src/lib/status-labels.ts` (source label if sources are labelled there)

**Interfaces:**
- Server contract (exact):

```
POST /api/receipts/inbox
  Authorization: Bearer <token>        (cookie also accepted; same guards as POST /api/receipts)
  Idempotency-Key: <queue item id>
  multipart/form-data: file (<= 15 MB, pdf/jpg/png/heic), capturedAt (ISO string)
  201 { "status": "queued",    "jobId": string, "uploadId": string }
  200 { "status": "duplicate", "receiptId": string | null }   same bytes already saved as a receipt
  400 / 413 / 415 { "error": string }        permanent: the queue marks the item failed
  429 { "error": string } + Retry-After       the queue waits Retry-After
  Rate limit: shares receipt-upload:<userId> 20 / 10 min with POST /api/receipts.
  Idempotent by content: the same bytes return the same staged upload and the same pending job.

On job completion (processDocumentJob), when payload.inbox is set, inside the same transaction:
  create Receipt { source: "app_capture", reviewStatus: "pending", uploadId, filePath, fileName,
                   extracted fields as mail-sync does (src/lib/mail-sync.ts:212-231) }
  claim the upload (claimedAt = now, expiresAt = now + 365 days).
On job failure with payload.inbox set: still create the pending receipt with empty amounts and
  notes "Tietoja ei saatu luettua kuvasta. Täydennä käsin." so no photo is ever lost.
```

- Queue schema (exact):

```ts
// IndexedDB "lashkirja-offline" v1, store "receipt-queue" (created in Task 7), keyPath "id", index "userId"
export interface QueuedReceipt {
  id: string;             // crypto.randomUUID(); also the Idempotency-Key
  userId: string;
  createdAt: number;      // epoch ms
  capturedAt: string;     // ISO, device clock
  fileName: string;
  mimeType: string;
  size: number;           // bytes, <= 15 * 1024 * 1024
  iv: Uint8Array;         // AES-GCM IV, same key as the cache (Task 7)
  data: ArrayBuffer;      // encrypted file bytes
  status: "queued" | "sending" | "failed" | "done";
  attempts: number;
  nextAttemptAt: number;  // epoch ms
  lastError?: string;     // Finnish, shown in the card
  jobId?: string;
}
export function nextAttemptDelayMs(attempts: number): number;   // 5 s, 30 s, 2 min, 10 min, then 30 min
export type SendOutcome = "done" | "retry" | "failed" | "paused";
/** 2xx -> done; 401 -> paused (until next sign-in); 408/429/5xx/network -> retry; other 4xx -> failed. */
export function classifySendResult(status: number | "network-error"): SendOutcome;
```

- [ ] **Server:** `receipt-inbox.ts` reuses the staging logic of `POST /api/receipts` (move `findReusableStagedUpload`, `acceptStagedUpload`-style helpers into a shared module; do not duplicate). A staged upload that already has `extractedJson` creates the pending receipt immediately. `DocumentJobPayload` gains `inbox?: { capturedAt: string }`.
- [ ] **Client driver** (mobile only, mounted in `AppShell` while signed in): drain order `createdAt`; one item at a time; triggers: app start, `online`, `lashkirja-reconnected`, `App` `appStateChange` to active, and a timer for the earliest `nextAttemptAt`. Uses `apiFetch(…, { offlineQueue: true, timeoutMs: 60_000 })` so Task 8 does not fail it fast. `done` items are deleted after 24 h. A `sending` item found at start (the app was killed mid-send) goes back to `queued`.
- [ ] **Capture path:** on `/kuitit/uusi` in the mobile build, when connectivity is not ok at pick time, or the online upload fails with a network error (not a 4xx), the file is enqueued, the screen shows `"Ei yhteyttä. Kuva tallennettiin ja lähetetään automaattisesti, kun yhteys palaa."` and returns to `/kuitit`. Online capture keeps today's flow into the editor.
- [ ] **UI:** `QueuedReceiptsCard` on `/kuitit` (only when the queue is non-empty): title `"Odottaa lähetystä"`, one row per item (file name, "Jonossa" / "Lähetetään…" / the error), per failed item "Yritä uudelleen" and "Poista" (with confirm). After upload, a one-line note: `"Lähetetty. Kuitti löytyy tarkistettavista, kun se on luettu."`
- [ ] **Logout with queued items:** the profile sheet's sign-out first shows `ConfirmModal`: `"<n> kuittia odottaa lähetystä. Jos kirjaudut ulos, ne poistetaan tästä laitteesta."`, buttons "Kirjaudu ulos" / "Peruuta". Logout clears the queue with the cache.
- [ ] **Tests:** unit for `nextAttemptDelayMs`, `classifySendResult`, crash recovery, ordering. Integration (`receipt-inbox.test.ts`, with `setDocumentExtractorForTests`): upload → job → pending receipt with `source: "app_capture"`; same bytes twice → one receipt; extractor throws → pending receipt with the note; 429 after 20 uploads carries `Retry-After`; a cookie-less bearer request from the app origin passes the guards.
- [ ] **Verify on Windows:** typecheck, lint, unit, integration (shim), mobile build. `receipt-queue.spec.ts` on :3210 against the dev DB (demo data may be written): go offline, pick a small JPEG fixture on `/kuitit/uusi` → back on `/kuitit` with one "Jonossa" row; close the page and open a new one in the same context (restart) → the row is still there; go online → within 10 s the row turns done and a pending receipt appears in Tarkistettavat (the dev box has no tesseract, so it is the "Täydennä käsin" variant). Delete that receipt afterwards through the API. Logout with one queued item shows the confirmation.
- [ ] Commit: `feat(receipts): offline photo queue that becomes pending receipts`

### Task 11: Bank return and email links via `lashkirja://`

**Files:**
- Modify: `app/package.json` (+ `@capacitor/browser`), `app/src/lib/enablebanking/consent.ts` (+ test), `app/src/lib/enablebanking/connect.ts`, `app/src/app/api/bank/connections/route.ts`, `app/src/lib/bank-return.ts` (+ test), `app/src/lib/open-bank-auth.ts`, `app/src/components/BankConnectCard.tsx`, `app/src/components/ShellGate.tsx`, `app/src/app/bank/callback/page.tsx`, `app/src/app/palauta-salasana/page.tsx`, `app/src/app/vahvista-sahkoposti/page.tsx`
- Create: `app/tests/e2e-mobile/bank-return.spec.ts`, `app/tests/integration/bank-app-state.test.ts`

**Interfaces:**
- Produces:

```ts
// src/lib/bank-return.ts
export const APP_BANK_STATE_PREFIX = "app1.";
export function isAppBankState(state: string | null | undefined): boolean;
/** "?code=..&state=app1.." -> "lashkirja://bank/callback?code=..&state=app1.." */
export function appReturnUrl(search: string): string;
// src/lib/enablebanking/consent.ts
export function createAuthState(client?: "web" | "app"): string;   // "app" -> "app1." + 64 hex
// POST /api/bank/connections body gains: client?: "web" | "app" (default "web")
```

- [ ] **Flow in the app:** `BankConnectCard` sends `client: "app"` on mobile. `leaveForBank(url)` on mobile opens `Browser.open({ url })` (in-app Safari view) instead of `location.assign`. The bank redirects to the registered `https://<server>/bank/callback?code&state=app1.…` (no Enable Banking panel change). That page, served by the WEB build on the server, sees an app state and immediately `location.replace(appReturnUrl(search))`; it also shows `"Palaa LashKirjaan"` as a button with the same href, for when iOS asks "Avataanko LashKirja?" and the user dismisses it. The app's `appUrlOpen` handler (`watchBankDeepLink`) calls `Browser.close()`, then `appNavigate("/bank/callback?…")`; the bundled callback page posts `code/state` to `/api/bank/connections/callback` with the bearer (the existing endpoint; `requireSession` accepts the bearer since Task 1).
- [ ] **Launch URL once:** `App.getLaunchUrl()` is consumed once per process (module flag plus a `sessionStorage` marker), fixing research H6.
- [ ] **Web behaviour** for web-started flows (`state` without prefix) is unchanged.
- [ ] **Email links:** password reset and email confirm links keep pointing at `APP_ORIGIN` (the web). Their success states add, only when `navigator.userAgent` is an iPhone/iPad, a link `"Avaa LashKirja-sovellus"` to `lashkirja://open`. `bankCallbackPath` stays the only in-app deep-link route; `lashkirja://open` just brings the app forward.
- [ ] **Tests:** unit for `isAppBankState`, `appReturnUrl` (encoding preserved), `createAuthState("app")` length and prefix, `bankCallbackPath` for both scheme forms. Integration: `POST /api/bank/connections` with `client: "app"` stores the hash of a prefixed state (use the existing bank test doubles; if Enable Banking is disabled in tests, test `startBankConsent` directly), and the callback with that state completes.
- [ ] **Verify on Windows:** typecheck, lint, unit, integration (shim). Web build: open `http://127.0.0.1:3200/bank/callback?code=x&state=app1.<64 hex>` in Chrome → the page issues a navigation to `lashkirja://bank/callback?code=x&state=app1.…` (capture with `page.on("request")` / `framenavigated`; Chrome will not open the scheme) and shows the "Palaa LashKirjaan" button. The same URL with a plain state keeps today's flow. Mobile build: simulate the deep link by calling the registered handler through a test hook (`window.__lashkirjaDeepLink?.(url)`, exposed only in non-native emulation) → `/bank/callback` renders inside the bundle and posts to the API with a bearer (the dev API answers 503 "not in use" if Enable Banking is off; assert the request and a clear error, no hang).
- [ ] Commit: `feat(bank): app-started bank consent returns through lashkirja://`

### Task 12: Native shell and the IPA workflow for the bundled UI

**Files:**
- Modify: `app/capacitor.config.ts`, `app/ios/App/App/MainViewController.swift`, `.github/workflows/build-ipa.yml`, `app/scripts/build-ios-ipa.sh`, `app/IOS-BUILD.md`, `app/ios/App/CapApp-SPM/Package.swift` (only if `cap sync` must regenerate it with the new plugins; CI regenerates it anyway)

- [ ] **`capacitor.config.ts`** (on top of the parallel agent's version, keep all their keys): `webDir: "out"`; remove the `CAPACITOR_SERVER_URL` branch entirely (no `server.url`, no `errorPath`); set `server: { iosScheme: "capacitor", hostname: "localhost" }` with a comment that the API's CORS allowlist (`MOBILE_APP_ORIGINS`) depends on exactly this origin; `plugins.CapacitorHttp: { enabled: false }`.
- [ ] **Native router** in `MainViewController.swift` (same file, see Task 5's note on `project.pbxproj`): `struct NextExportRouter: Router` implementing exactly `resolveExportPath` from Task 4 with `FileManager.default.fileExists(atPath:)` against `basePath`, and `override func router() -> Router { NextExportRouter() }` in `MainViewController`. Keep `CancelledNavigationIgnoringDelegate` and the splash safety net untouched.
- [ ] **`build-ipa.yml`:** input `api_base_url` (required, must start with `https://`) replaces `capacitor_server_url`. Steps: checkout, Node, `npm ci`, `npx prisma generate` (the mobile `next build` type-checks the whole project, including route handlers that import the generated client), `npm run build:mobile -- --api-base-url "$API_BASE_URL"`, `npx cap sync ios`, `npx tsx scripts/patch-ios-url-scheme.ts`. Remove the `patch-ios-offline-server.ts` step and its grep. Assertions after sync: `ios/App/App/capacitor.config.json` has no `"url"` key (`! grep -q '"url"'`), `ios/App/App/public/index.html` and `ios/App/App/public/_next/static` exist, the API base URL appears in `ios/App/App/public/_next/static`, `<string>lashkirja</string>` in Info.plist, no "Tilikirja". After packaging: print the IPA size and fail if it is under 2 MB (a remote-URL shell was about 1 MB).
- [ ] **`build-ios-ipa.sh`:** `API_BASE_URL` replaces `CAPACITOR_SERVER_URL`; run `npm run build:mobile -- --api-base-url "$API_BASE_URL"` before `cap sync`; drop the offline-server patch call; update the echo text.
- [ ] **`IOS-BUILD.md`:** the bundled model in a short section: two targets, where the URL goes, that UI changes now need a new IPA, that server deploys must stay backward compatible with the installed IPA (API version header), and how to verify locally (Task 4 harness).
- [ ] **Verify:** on Windows: `npm run build:mobile -- --api-base-url https://api.example.invalid`, `npx cap sync ios` (on Windows it copies `out/` into `ios/App/App/public` and writes `capacitor.config.json`; if it refuses on Windows, note it and rely on CI), then check `ios/App/App/capacitor.config.json` has no `url` and the copied `public/` has `laskut/lasku.html`. Do not commit `ios/App/App/public` or `capacitor.config.json` (gitignored; confirm). Then push the branch to `github` and run `build-ipa.yml` with `api_base_url=https://api.example.invalid` as a compile check: Swift (router, and the Keychain plugin if Task 5 needed it) compiles, all assertions pass, IPA ≥ 2 MB. Download the artifact and confirm `Payload/App.app/public/index.html` exists.
- [ ] Commit: `feat(ios): bundle the static export, no server.url, export-aware router`

### Task 13: Ship: deploy the server, build the IPA, verify against production (read-only)

**Files:** none planned. Fix-forward commits only if a check fails. Report to `.superpowers/sdd/2026-09-28-real-app-b-bundled/task-13-report.md`.

- [ ] **Order:** server first, then IPA. An installed older IPA keeps working against the new server (remote mode still serves the web build with cookies), and the new IPA needs the new API.
- [ ] **Push** `feat/real-app-phase01` to `github`. Confirm CI (`ci.yml`) is green if it ran for this ref; otherwise run the full local suite list from Global Constraints once more.
- [ ] **Deploy:** `powershell -NoProfile -ExecutionPolicy Bypass -File C:\LashKirja\prod\app\scripts\ops\deploy-local.ps1 -Remote github -Ref feat/real-app-phase01`. Expect health 200 at the end. No `.env` change is needed (`MOBILE_APP_ORIGINS` defaults to `capacitor://localhost`; the token reuses `SESSION_SECRET`). If the deploy rolls back, stop and report the log path.
- [ ] **Server checks against production, read-only** (Node script from the scratchpad, `https://desktop-7gu8ukj.tail42feb1.ts.net:8443`):
  - `OPTIONS /api/dashboard` with `Origin: capacitor://localhost`, `Access-Control-Request-Method: GET`, `Access-Control-Request-Headers: authorization` → 204 with the Task 2 headers.
  - Same with `Origin: http://127.0.0.1:3210` → 403 (production refuses the emulation origin).
  - `GET /api/dashboard` with `Origin: capacitor://localhost` and no token → 401 JSON carrying `Access-Control-Allow-Origin: capacitor://localhost` and `X-LashKirja-Api-Version: 1`.
  - `GET /api/auth/me` with a garbage bearer → 401, no `set-cookie`.
  - The web app still loads in Chrome at the production URL (login page renders; no login unless the controller supplied credentials).
- [ ] **Build the IPA:** run `build-ipa.yml` on `feat/real-app-phase01` with `api_base_url=https://desktop-7gu8ukj.tail42feb1.ts.net:8443`. Download the artifact. Confirm inside: `Payload/App.app/capacitor.config.json` has no `url`; `Payload/App.app/public/index.html` exists; the production URL appears under `public/_next/static`; `CFBundleDisplayName` is LashKirja; the lashkirja scheme is in Info.plist. Record the IPA size (expected several MB).
- [ ] **Bundle against production, read-only:** unzip `Payload/App.app/public` to the scratchpad, serve it with `scripts/mobile/serve-export.ts --root <that dir>`, and open it in Chrome with `args: ["--disable-web-security"]` (production correctly refuses the emulation origin; the CORS contract itself was checked above). Block every request that is not `GET`, `HEAD` or `OPTIONS` with `page.route("**/*", …)`, except `POST /api/auth/token` and `POST /api/auth/logout` and only if the controller supplied credentials. Checks: `/` boots to the login page with no request to the dev server; the offline banner appears with the context offline; if credentials were supplied: login, Koti, Myynti, Kirjanpito, Raportit and Asetukset each render an h1 with production data, one invoice detail via `?id=`, then logout.
- [ ] **Hand over:** the IPA path, its size, the report, and the owner's device checks: (1) the app opens with the network off and shows the login or the last data, (2) `crypto.subtle` works (the build info line in Asetukset shows "Välimuisti: salattu", Task 8), (3) a receipt photo taken offline uploads after reconnecting, (4) an invoice PDF opens in the share sheet, (5) logout and login work.
- [ ] Commit only fixes, each with its own message.

---

## Self-review against the spec

- Faz 4 bullet 1 (token in Keychain, one API address, CORS, signed/authed file links): Tasks 1, 2, 5, 9. Files use authenticated fetch to blob rather than signed URLs, which avoids a signing scheme and CORP issues with `<img>`.
- Faz 4 bullet 2 (static UI inside the IPA; `/`, `/dashboard`, the four `[id]` pages, proxy, `headers()`/`redirects()`): Tasks 3, 4, 12.
- Faz 4 bullet 3 (bank OAuth return and email links): Task 11, with the custom scheme instead of universal links (decision 2).
- Faz 4 bullet 4 (offline receipt queue): Task 10.
- Faz 4 bullet 5 (hosted server before the App Store): deferred, the URL is one build input.
- Faz 2 A1, A2, A3, A4: Task 6. A6: Task 7. A7: Tasks 5 and 6. A5 stays client-fetch by design (research §2.3 A5 says so for B).
- Owner directives: offline banner and fail-fast writes (Task 8), files through the share sheet (Task 9), IPA with no `server.url` and the API URL as a workflow input (Task 12), production deploy with `-Remote github` and read-only verification (Task 13).
