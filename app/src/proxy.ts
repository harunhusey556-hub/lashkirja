import { unsealData } from "iron-session";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { SessionData, sessionOptions } from "@/lib/session-options";

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
];

export function isPublicPage(pathname: string): boolean {
  return PUBLIC_PAGES.includes(pathname);
}

const PUBLIC_API_PREFIXES = ["/api/auth/", "/api/cron/", "/api/health"];

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
  const revoked = await isRevoked(session);
  return { authenticated: !revoked, revoked };
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

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // --- API routes: decided once, and never fall through to the page gate ---
  if (pathname.startsWith("/api/")) {
    if (isPublicApi(pathname)) {
      return NextResponse.next();
    }
    // Protected API routes (everything under /api/ except auth, cron, health).
    const { authenticated: isAuthenticated } = await checkAuth(request, false);
    if (!isAuthenticated) {
      // An invalid or missing cookie is signed-out already; clearing it here
      // stops the browser from resending garbage on every later request.
      return clearSessionCookie(
        NextResponse.json(
          { error: { code: "UNAUTHORIZED", message: "Kirjautuminen vaaditaan" } },
          { status: 401 }
        )
      );
    }
    return NextResponse.next();
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
  if (pathname === "/login" && isAuthenticated) {
    return redirectForRequest(request, "/dashboard");
  }

  const response = NextResponse.next();
  if (isProtected) {
    // Belt-and-suspenders alongside signOut()'s location.replace() +
    // clearPageCache(): without this, a bfcache/back-forward restore of a
    // fully-loaded protected page's *document* response is theoretically
    // possible even after logout. API/file routes already set this.
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
    "/((?!api/|_next/|favicon\\.ico$|manifest\\.json$|offline\\.html$|index\\.html$|icons/|.*\\.(?:png|svg|jpg|jpeg|webp|ico|txt|webmanifest)$).*)",
  ],
};
