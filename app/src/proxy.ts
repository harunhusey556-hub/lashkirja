import { unsealData } from "iron-session";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { SessionData, sessionOptions } from "@/lib/session-options";
import { readCredential } from "@/lib/auth-credential";
import { API_VERSION, corsPreflightHeaders, corsResponseHeaders, isAppClientOrigin } from "@/lib/app-origins";

/**
 * Next.js 16 proxy — the replacement for middleware.ts.
 * Protects both page routes and API routes. New routes are protected by default
 * unless explicitly listed in PUBLIC_API_PREFIXES.
 *
 * `config.matcher` below has two separate entries on purpose: one that always
 * matches every /api/* path, and one for pages that skips Next internals and
 * static files. Do not fold them back into a single pattern — a combined
 * extension exclusion (e.g. ".*\\.(?:png|jpg|...)$") also matches API routes
 * that happen to end in one of those extensions (like /api/uploads/x.jpg),
 * letting them skip this gate entirely.
 */

/** Signed-out screens. Every other page requires a session. */
export const PUBLIC_PAGES: readonly string[] = [
  "/login",
  "/unohtunut-salasana",
  "/palauta-salasana",
  "/vahvista-sahkoposti",
  // Task 11: an app-started bank consent redirects back here from
  // Capacitor's in-app Browser (SFSafariViewController on iOS), a
  // completely separate browsing context with no session cookie -- the
  // web-started flow's own cookie only ever existed because that flow
  // never leaves the same browser tab. Gating this page on a cookie would
  // bounce every app-started return straight to /login before the page
  // ever got to run its own bounce back into lashkirja:// (bank-return.ts,
  // bank/callback/page.tsx). The actual API call the page makes
  // (POST /api/bank/connections/callback) still requires its own bearer or
  // cookie via requireSession(), independent of this page-level check.
  "/bank/callback",
];

export function isPublicPage(pathname: string): boolean {
  return PUBLIC_PAGES.includes(pathname);
}

// /api/stripe/webhook has no session: Stripe signs the body and the route
// verifies that signature (HMAC) before doing anything.
// /api/pos/onboarding/return has no session either: it carries no data,
// changes nothing and only redirects to the app's fixed lashkirja:// link.
const PUBLIC_API_PREFIXES = [
  "/api/auth/",
  "/api/cron/",
  "/api/health",
  "/api/stripe/webhook",
  "/api/pos/onboarding/return",
];

function isPublicApi(pathname: string): boolean {
  return PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function redirectForRequest(request: NextRequest, path: string, search = "") {
  // NextResponse.redirect requires an absolute URL in proxy. Keep the
  // request's current origin so LAN/Tailscale access continues to work.
  const url = request.nextUrl.clone();
  url.pathname = path;
  url.search = search;
  return NextResponse.redirect(url, 307);
}

/** Unseals the cookie only. No DB — this is the cheap check used everywhere
 * except the two routes below. */
async function unsealSession(request: NextRequest): Promise<SessionData | null> {
  const sealed = request.cookies.get(sessionOptions.cookieName)?.value;
  if (!sealed) return null;
  try {
    return await unsealData<SessionData>(sealed, {
      password: sessionOptions.password,
      ttl: sessionOptions.ttl,
    });
  } catch {
    return null;
  }
}

/**
 * A cookie whose row was revoked (logout-all, a password reset, an account
 * close) still unseals cleanly — only the signature is checked there, the
 * server state behind it is gone. Detecting that needs a DB lookup, so it
 * runs only where an un-checked cookie causes the /login <-> /dashboard
 * loop (research §3, H3): the login screen, which would otherwise bounce an
 * authenticated-looking cookie straight back to /dashboard, and the root
 * redirect. Every other route keeps the cheap, DB-free check — its own
 * requireSession() call (in the route handler, or DashboardClient's
 * /api/auth/me probe) is the authoritative check per request.
 *
 * `@/lib/db` is imported dynamically so a request that never reaches this
 * function — i.e. everything except a cookie-bearing hit on "/" or
 * "/login" — never loads Prisma. That matters for the unit test suite,
 * which runs with no database configured and must never touch the real
 * one by accident.
 */
async function isRevoked(session: SessionData): Promise<boolean> {
  if (!session.userId) return false;
  const { prisma } = await import("@/lib/db");
  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { legacySessionsRevokedAt: true, accessDisabledAt: true },
  });
  if (!user || user.accessDisabledAt) return true;
  if (!session.sessionId) return Boolean(user.legacySessionsRevokedAt);
  const row = await prisma.authSession.findFirst({
    where: { id: session.sessionId, userId: session.userId, revokedAt: null },
    select: { id: true },
  });
  return !row;
}

type AuthCheck = { authenticated: boolean; revoked: boolean };

async function checkAuth(request: NextRequest, deep: boolean): Promise<AuthCheck> {
  const session = await unsealSession(request);
  if (!session?.userId) return { authenticated: false, revoked: false };
  if (!deep) return { authenticated: true, revoked: false };
  try {
    const revoked = await isRevoked(session);
    return { authenticated: !revoked, revoked };
  } catch (error) {
    // A transient DB error (SQLite busy/locked, a connection hiccup) must
    // not turn /login or / into a 500 -- fail closed instead: treat the
    // cookie as signed out. This still renders /login (isProtected is
    // false there) and, on /, redirects to /login without clearing the
    // cookie (revoked stays false), so a real, still-valid session is not
    // lost over a momentary DB blip. Final review M2.
    console.error("proxy: revocation check failed (DB error); treating as signed out", error);
    return { authenticated: false, revoked: false };
  }
}

/** Full attribute parity with how the cookie was set (path, secure,
 * httpOnly, sameSite) so the browser actually drops it, not a bare
 * `cookies.delete(name)` whose default path may not match. */
function clearSessionCookie(response: NextResponse): NextResponse {
  response.cookies.set(sessionOptions.cookieName, "", {
    ...sessionOptions.cookieOptions,
    maxAge: 0,
  });
  return response;
}

/**
 * Every /api/* response, whatever the Origin, carries the API version.
 * When the Origin is an allowed app-client origin it also gets the CORS
 * response headers (ACAO, expose-headers, Vary). This is the one place
 * that sets these, so no /api/* return path in proxy() can miss it —
 * including the proxy's own 401.
 */
function withApiHeaders(response: NextResponse, origin: string | null): NextResponse {
  response.headers.set("X-LashKirja-Api-Version", String(API_VERSION));
  if (origin && isAppClientOrigin(origin)) {
    for (const [key, value] of Object.entries(corsResponseHeaders(origin))) {
      response.headers.set(key, value);
    }
  }
  return response;
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // --- API routes: decided once, and never fall through to the page gate ---
  if (pathname.startsWith("/api/")) {
    const origin = request.headers.get("origin");

    // Preflight is answered here, before any auth check, and for every
    // /api/* path (public or protected) alike.
    if (request.method === "OPTIONS") {
      if (!origin || !isAppClientOrigin(origin)) {
        return withApiHeaders(NextResponse.json({ error: "Pyyntö estettiin" }, { status: 403 }), null);
      }
      return withApiHeaders(new NextResponse(null, { status: 204, headers: corsPreflightHeaders(origin) }), origin);
    }

    if (isPublicApi(pathname)) {
      return withApiHeaders(NextResponse.next(), origin);
    }
    // Protected API routes (everything under /api/ except auth, cron, health).
    // Format-only check (no DB): a bearer token or a well-formed cookie
    // passes here, and each route handler's own requireSession() call does
    // the authoritative, DB-backed check (revocation, disabled account).
    const cookieValue = request.cookies.get(sessionOptions.cookieName)?.value;
    const credential = await readCredential(request.headers, cookieValue, isAppClientOrigin);
    if (!credential) {
      // An invalid or missing cookie is signed-out already; clearing it here
      // stops the browser from resending garbage on every later request.
      // (Harmless no-op for a bearer-only caller, which never sent one.)
      return withApiHeaders(
        clearSessionCookie(
          NextResponse.json(
            { error: { code: "UNAUTHORIZED", message: "Kirjautuminen vaaditaan" } },
            { status: 401 }
          )
        ),
        origin
      );
    }
    return withApiHeaders(NextResponse.next(), origin);
  }

  // --- Page routes: protected unless explicitly public ---
  const deep = pathname === "/login" || pathname === "/";
  const { authenticated: isAuthenticated, revoked } = await checkAuth(request, deep);
  const isProtected = !isPublicPage(pathname);
  if (isProtected && !isAuthenticated) {
    // Deep-link continue-after-login: remember where the user was headed.
    const target = `${pathname}${request.nextUrl.search}`;
    const search = target === "/" ? "" : `?next=${encodeURIComponent(target)}`;
    const response = redirectForRequest(request, "/login", search);
    return revoked ? clearSessionCookie(response) : response;
  }
  // Authenticated "/" used to fall through to page.tsx, which did this
  // redirect itself with a server-side getSession() call -- unsupported in
  // the mobile static export (no cookies() there). Deciding it here keeps
  // the web app's redirect one hop shorter and lets page.tsx stay
  // cookie-free on both targets (Task 4; BootRedirect.tsx does the
  // equivalent client-side for the mobile build, which has no proxy).
  if ((pathname === "/login" || pathname === "/") && isAuthenticated) {
    return redirectForRequest(request, "/dashboard");
  }

  const response = NextResponse.next();
  if (isProtected || pathname === "/bank/callback") {
    // Belt-and-suspenders alongside signOut()'s location.replace() +
    // clearPageCache(): without this, a bfcache/back-forward restore of a
    // fully-loaded protected page's *document* response is theoretically
    // possible even after logout. API/file routes already set this.
    // /bank/callback is public (see PUBLIC_PAGES above) but still carries a
    // one-time code/state in its own URL, so it keeps the same header.
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
  }
  return revoked ? clearSessionCookie(response) : response;
}

export const config = {
  matcher: [
    // Every API route, unconditionally — never skipped by the extension
    // exclusions below (an upload path like /api/uploads/x.jpg must still
    // hit the gate).
    "/api/:path*",
    // Pages: everything except /api (handled above), Next internals, and
    // files served from public/. The fixed-name exclusions are anchored
    // with `$` so a real page like /manifest.jsonfoo is still matched.
    // OWN-21: Apple's CDN fetches /.well-known/apple-app-site-association
    // anonymously before iOS lets the app use passkeys; a redirect to /login
    // there breaks passkeys, so the proxy never runs on it.
    "/((?!api/|_next/|favicon\\.ico$|manifest\\.json$|offline\\.html$|index\\.html$|\\.well-known/apple-app-site-association$|icons/|.*\\.(?:png|svg|jpg|jpeg|webp|ico|txt|webmanifest)$).*)",
  ],
};
