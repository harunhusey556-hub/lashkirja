import { getIronSession, IronSession } from "iron-session";
import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { redirectResponse, sessionOptions, type SessionData } from "@/lib/session-options";

export { redirectResponse, sessionOptions };
export type { SessionData };

export async function getSession() {
  const cookieStore = await cookies();
  return getIronSession<SessionData>(cookieStore, sessionOptions);
}

/** Read session from an incoming API request (reads Cookie header directly). */
export async function getSessionFromRequest(req: NextRequest) {
  const res = NextResponse.next();
  return getIronSession<SessionData>(req, res, sessionOptions);
}

/** A session that has passed the requireSession check — userId is guaranteed. */
export type AuthenticatedSession = IronSession<SessionData> & { userId: string };

const SESSION_TOUCH_MS = 5 * 60 * 1000;

/**
 * Returns the session if logged in, otherwise null.
 * A cookie that names a session row is refused once that row is revoked.
 * Cookies sealed before session tracking have no sessionId and stay valid,
 * so an existing demo login is not dropped by this check.
 */
export async function requireSession(req?: NextRequest): Promise<AuthenticatedSession | null> {
  const session = req ? await getSessionFromRequest(req) : await getSession();
  if (!session.userId) return null;
  if (session.sessionId) {
    const row = await prisma.authSession.findFirst({
      where: { id: session.sessionId, userId: session.userId, revokedAt: null },
      select: { id: true, lastSeenAt: true },
    });
    if (!row) return null;
    if (Date.now() - row.lastSeenAt.getTime() > SESSION_TOUCH_MS) {
      await prisma.authSession
        .update({ where: { id: row.id }, data: { lastSeenAt: new Date() } })
        .catch(() => undefined);
    }
  }
  return session as AuthenticatedSession;
}
