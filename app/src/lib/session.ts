import { getIronSession, SessionOptions } from "iron-session";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

const isProduction = process.env.NODE_ENV === "production";
const configuredSecret = process.env.SESSION_SECRET?.trim();
const developmentSecret = "lashkirja-local-development-only-secret-32-chars";

if (isProduction && (!configuredSecret || configuredSecret.length < 32)) {
  throw new Error("SESSION_SECRET must be configured with at least 32 characters in production");
}

const cookieSecure = process.env.COOKIE_SECURE === undefined
  ? isProduction
  : process.env.COOKIE_SECURE === "true";

export interface SessionData {
  userId?: string;
  email?: string;
  firstName?: string;
}

export const sessionOptions: SessionOptions = {
  password: configuredSecret || developmentSecret,
  ttl: 8 * 60 * 60,
  cookieName: cookieSecure ? "__Host-lashkirja-session" : "lashkirja-session",
  cookieOptions: {
    secure: cookieSecure,
    httpOnly: true,
    sameSite: "lax" as const,
    path: "/",
    maxAge: 8 * 60 * 60,
  },
};

/** A relative Location is safe across localhost/LAN/Tailscale hostnames. */
export function redirectResponse(path: string, status = 303): NextResponse {
  if (!path.startsWith("/") || path.startsWith("//")) {
    throw new Error("Redirect target must be an application-relative path");
  }
  return new NextResponse(null, { status, headers: { Location: path } });
}

export async function getSession() {
  const cookieStore = await cookies();
  return getIronSession<SessionData>(cookieStore, sessionOptions);
}

/** Read session from an incoming API request (reads Cookie header directly). */
export async function getSessionFromRequest(req: NextRequest) {
  const res = NextResponse.next();
  return getIronSession<SessionData>(req, res, sessionOptions);
}

/** Returns the session if logged in, otherwise null. */
export async function requireSession(req?: NextRequest) {
  const session = req ? await getSessionFromRequest(req) : await getSession();
  return session.userId ? session : null;
}
