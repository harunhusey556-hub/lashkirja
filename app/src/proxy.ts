import { unsealData } from "iron-session";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { SessionData, sessionOptions } from "@/lib/session";

/**
 * Next.js 16 proxy — the replacement for middleware.ts.
 * Protects both page routes and API routes. New routes are protected by default
 * unless explicitly listed in PUBLIC_API_PREFIXES.
 */

const protectedPrefixes = [
  "/dashboard",
  "/kuitit",
  "/tiliotteet",
  "/alv-raportti",
  "/asetukset",
  "/laskut",
  "/asiakkaat",
  "/ostolaskut",
  "/toistuvat",
  "/pankkitilit",
  "/raportit",
];

const PUBLIC_API_PREFIXES = ["/api/auth/", "/api/cron/"];

function isPublicApi(pathname: string): boolean {
  return PUBLIC_API_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function redirectForRequest(request: NextRequest, path: string) {
  // NextResponse.redirect requires an absolute URL in proxy. Keep the
  // request's current origin so LAN/Tailscale access continues to work.
  const url = request.nextUrl.clone();
  url.pathname = path;
  url.search = "";
  return NextResponse.redirect(url, 307);
}

async function authenticated(request: NextRequest) {
  const sealed = request.cookies.get(sessionOptions.cookieName)?.value;
  if (!sealed) return false;

  try {
    const session = await unsealData<SessionData>(sealed, {
      password: sessionOptions.password,
      ttl: sessionOptions.ttl,
    });
    return Boolean(session.userId);
  } catch {
    return false;
  }
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;

  // --- Protected API routes (everything under /api/ except auth and cron) ---
  if (pathname.startsWith("/api/") && !isPublicApi(pathname)) {
    const isAuthenticated = await authenticated(request);
    if (!isAuthenticated) {
      return NextResponse.json(
        { error: { code: "UNAUTHORIZED", message: "Kirjautuminen vaaditaan" } },
        { status: 401 }
      );
    }
    return NextResponse.next();
  }

  // --- Protected page routes ---
  const isProtected = protectedPrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );

  if (!isProtected && pathname !== "/login") {
    return NextResponse.next();
  }

  const isAuthenticated = await authenticated(request);
  if (isProtected && !isAuthenticated) {
    return redirectForRequest(request, "/login");
  }
  if (pathname === "/login" && isAuthenticated) {
    return redirectForRequest(request, "/dashboard");
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/kuitit/:path*",
    "/tiliotteet/:path*",
    "/alv-raportti/:path*",
    "/asetukset/:path*",
    "/laskut/:path*",
    "/asiakkaat/:path*",
    "/ostolaskut/:path*",
    "/toistuvat/:path*",
    "/pankkitilit/:path*",
    "/raportit/:path*",
    "/login",
    "/api/:path*",
  ],
};
