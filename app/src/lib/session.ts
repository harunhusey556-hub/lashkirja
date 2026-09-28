import { getIronSession, IronSession } from "iron-session";
import { cookies, headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { redirectResponse, sessionOptions, type SessionData } from "@/lib/session-options";
import { readCredential } from "@/lib/auth-credential";
import { isAppClientOrigin } from "@/lib/app-origins";

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

/** A session that has passed the requireSession check — userId, email and
 * firstName are guaranteed (both come from the DB user row, not the possibly
 * stale token/cookie payload). A bearer session's save()/destroy() are
 * no-ops and updateConfig() is a no-op: there is no cookie to touch. */
export type AuthenticatedSession = IronSession<SessionData> & {
  userId: string;
  email: string;
  firstName: string;
};

const SESSION_TOUCH_MS = 5 * 60 * 1000;

/**
 * Returns the session if logged in, otherwise null. Accepts either an
 * Authorization: Bearer token or the iron-session cookie (see
 * readCredential — the header always wins and never falls back to the
 * cookie).
 *
 * A cookie/token that names a session row is refused once that row is
 * revoked. A cookie sealed before session tracking has no sessionId. It
 * works only until logout-all or a password change sets
 * User.legacySessionsRevokedAt. After that the only path back in is a new
 * login, which seals a session id.
 */
export async function requireSession(req?: NextRequest): Promise<AuthenticatedSession | null> {
  const requestHeaders = req ? req.headers : await headers();
  const cookieValue = req
    ? req.cookies.get(sessionOptions.cookieName)?.value
    : (await cookies()).get(sessionOptions.cookieName)?.value;
  const credential = await readCredential(requestHeaders, cookieValue, isAppClientOrigin);
  if (!credential) return null;

  const user = await prisma.user.findUnique({
    where: { id: credential.data.userId },
    select: { legacySessionsRevokedAt: true, accessDisabledAt: true, email: true, firstName: true },
  });
  // A completed close request disables access and leaves the books in place.
  if (!user || user.accessDisabledAt) return null;

  if (credential.kind === "bearer") {
    const row = await prisma.authSession.findFirst({
      where: { id: credential.data.sessionId, userId: credential.data.userId, revokedAt: null },
      select: { id: true, lastSeenAt: true },
    });
    if (!row) return null;
    if (Date.now() - row.lastSeenAt.getTime() > SESSION_TOUCH_MS) {
      await prisma.authSession
        .update({ where: { id: row.id }, data: { lastSeenAt: new Date() } })
        .catch(() => undefined);
    }
    return {
      userId: credential.data.userId,
      sessionId: credential.data.sessionId,
      email: user.email,
      firstName: user.firstName,
      kind: "bearer" as const,
      save: async () => {},
      destroy: () => {},
      updateConfig: () => {},
    } as unknown as AuthenticatedSession;
  }

  // Cookie credential: rebuild the live iron session so any future caller
  // that needs save()/destroy() still gets the real thing.
  const session = req ? await getSessionFromRequest(req) : await getSession();
  if (!session.userId) return null;
  if (!session.sessionId) {
    if (user.legacySessionsRevokedAt) return null;
    session.email = user.email;
    session.firstName = user.firstName;
    return session as AuthenticatedSession;
  }
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
  session.email = user.email;
  session.firstName = user.firstName;
  return session as AuthenticatedSession;
}
