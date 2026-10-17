import { getIronSession, IronSession } from "iron-session";
import { cookies, headers } from "next/headers";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { redirectResponse, sessionOptions, type SessionData } from "@/lib/session-options";
import { readCredential } from "@/lib/auth-credential";
import { isAppClientOrigin } from "@/lib/app-origins";
import {
  ROTATION_GRACE_MS,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  SESSION_TOUCH_MS,
} from "@/lib/session-limits";

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
  /** Only populated for a bearer credential: when the underlying AuthSession
   * row was created (epoch ms). Refreshed tokens carry it on unchanged. */
  sessionStartedAt?: number;
  /** Bearer only: the generation the presented token carries (0 for legacy tokens). */
  credentialGeneration?: number;
  /** Bearer only: the row's newest committed generation. Above the token's own,
   * the token was accepted only through the rotation grace. */
  tokenGeneration?: number;
  /** Bearer only: the row's device key (base64), null when the session is unbound. */
  deviceKey?: string | null;
};

/** Why a request is not signed in; the app tells "sign in again" from "retry" by it. */
export type AuthFailureReason = "invalid" | "revoked" | "idle" | "absolute" | "reuse";

export type AuthResult =
  | { session: AuthenticatedSession; reason?: undefined }
  | {
      session: null;
      reason: AuthFailureReason;
      sessionId?: string;
      userId?: string;
    };

type SessionRow = {
  id: string;
  lastSeenAt: Date;
  createdAt: Date;
  tokenGeneration: number;
  rotatedAt: Date | null;
  deviceKey: string | null;
};

const ROW_SELECT = {
  id: true,
  lastSeenAt: true,
  createdAt: true,
  tokenGeneration: true,
  rotatedAt: true,
  deviceKey: true,
} as const;

/** Revokes a row the server itself ended; a concurrent sign-out keeps its own (null) reason. */
async function endSession(id: string, reason: "idle" | "absolute" | "reuse") {
  await prisma.authSession.updateMany({
    where: { id, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}

/** A token generation that was already replaced is back in play: someone holds a copy. Kill the whole family. */
export async function revokeForReuse(sessionId: string, userId: string, presented: number, committed: number) {
  await endSession(sessionId, "reuse");
  // Ids and generations only, never the token.
  console.warn(
    `[auth] refresh token reuse: session=${sessionId} user=${userId} presentedGen=${presented} currentGen=${committed}`
  );
}

type GenerationVerdict = "ok" | "commit" | "rotated" | "invalid";

function judgeGeneration(row: SessionRow, gen: number, now: number): GenerationVerdict {
  if (gen === row.tokenGeneration) return "ok";
  if (gen === row.tokenGeneration + 1) return "commit";
  if (gen > row.tokenGeneration + 1) return "invalid";
  // One behind is a request that was in flight while the refresh committed.
  if (gen === row.tokenGeneration - 1 && row.rotatedAt && now - row.rotatedAt.getTime() <= ROTATION_GRACE_MS) {
    return "ok";
  }
  return "rotated";
}

/**
 * Brings a bearer token's generation in line with its row. A refresh response
 * can be lost on the way to the device, so a new generation is committed the
 * first time it is *used*, not when it is issued: the device then never holds
 * a token the server has already moved past.
 */
async function settleGeneration(
  row: SessionRow,
  gen: number
): Promise<{ verdict: "ok" | "rotated" | "invalid"; tokenGeneration: number }> {
  let current = row;
  // The commit can lose a race against a parallel request carrying the same token.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const now = Date.now();
    const verdict = judgeGeneration(current, gen, now);
    if (verdict !== "commit") return { verdict, tokenGeneration: current.tokenGeneration };
    const committed = await prisma.authSession.updateMany({
      where: { id: current.id, tokenGeneration: current.tokenGeneration, revokedAt: null },
      data: { tokenGeneration: gen, rotatedAt: new Date(now) },
    });
    if (committed.count === 1) return { verdict: "ok", tokenGeneration: gen };
    const fresh = await prisma.authSession.findFirst({
      where: { id: current.id, revokedAt: null },
      select: ROW_SELECT,
    });
    if (!fresh) return { verdict: "invalid", tokenGeneration: current.tokenGeneration };
    current = fresh;
  }
  return { verdict: "invalid", tokenGeneration: current.tokenGeneration };
}

/** lastSeenAt only has to resolve the idle limit, so it is written rarely. */
async function touch(row: SessionRow) {
  if (Date.now() - row.lastSeenAt.getTime() <= SESSION_TOUCH_MS) return;
  await prisma.authSession
    .update({ where: { id: row.id }, data: { lastSeenAt: new Date() } })
    .catch(() => undefined);
}

/** Idle and absolute limits for any row-backed session; revokes the row and says which one ended it. */
async function expiredReason(row: SessionRow): Promise<"idle" | "absolute" | null> {
  const now = Date.now();
  if (now - row.createdAt.getTime() > SESSION_ABSOLUTE_MS) {
    await endSession(row.id, "absolute");
    return "absolute";
  }
  if (now - row.lastSeenAt.getTime() > SESSION_IDLE_MS) {
    await endSession(row.id, "idle");
    return "idle";
  }
  return null;
}

/**
 * Like requireSession, but says why a request is not signed in. For every
 * row-backed session (bearer, and a cookie that names a session row) the row
 * decides: revoked or missing, idle for SESSION_IDLE_MS, older than
 * SESSION_ABSOLUTE_MS. A bearer token must also carry a usable generation
 * (settleGeneration). One the row has moved past revokes the session on any
 * route, not only on a refresh: whoever refreshed first may be the copy.
 */
export async function authenticate(req?: NextRequest): Promise<AuthResult> {
  const requestHeaders = req ? req.headers : await headers();
  const cookieValue = req
    ? req.cookies.get(sessionOptions.cookieName)?.value
    : (await cookies()).get(sessionOptions.cookieName)?.value;
  const credential = await readCredential(requestHeaders, cookieValue, isAppClientOrigin);
  if (!credential) return { session: null, reason: "invalid" };
  const { userId } = credential.data;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { legacySessionsRevokedAt: true, accessDisabledAt: true, email: true, firstName: true },
  });
  // A completed close request disables access and leaves the books in place.
  if (!user || user.accessDisabledAt) return { session: null, reason: "revoked", userId };

  if (credential.kind === "bearer") {
    const { sessionId } = credential.data;
    const row = await prisma.authSession.findFirst({
      where: { id: sessionId, userId, revokedAt: null },
      select: ROW_SELECT,
    });
    if (!row) return { session: null, reason: "revoked", sessionId, userId };
    const expired = await expiredReason(row);
    if (expired) return { session: null, reason: expired, sessionId, userId };

    const gen = credential.data.gen ?? 0;
    const settled = await settleGeneration(row, gen);
    if (settled.verdict === "rotated") {
      await revokeForReuse(sessionId, userId, gen, settled.tokenGeneration);
      return { session: null, reason: "reuse", sessionId, userId };
    }
    if (settled.verdict !== "ok") return { session: null, reason: settled.verdict, sessionId, userId };
    await touch(row);
    return {
      session: {
        userId,
        sessionId,
        email: user.email,
        firstName: user.firstName,
        kind: "bearer" as const,
        sessionStartedAt: row.createdAt.getTime(),
        credentialGeneration: gen,
        tokenGeneration: settled.tokenGeneration,
        deviceKey: row.deviceKey,
        save: async () => {},
        destroy: () => {},
        updateConfig: () => {},
      } as unknown as AuthenticatedSession,
    };
  }

  // Cookie credential: rebuild the live iron session so any future caller
  // that needs save()/destroy() still gets the real thing.
  const session = req ? await getSessionFromRequest(req) : await getSession();
  if (!session.userId) return { session: null, reason: "invalid" };
  if (!session.sessionId) {
    if (user.legacySessionsRevokedAt) return { session: null, reason: "revoked", userId: session.userId };
    session.email = user.email;
    session.firstName = user.firstName;
    return { session: session as AuthenticatedSession };
  }
  const row = await prisma.authSession.findFirst({
    where: { id: session.sessionId, userId: session.userId, revokedAt: null },
    select: ROW_SELECT,
  });
  if (!row) return { session: null, reason: "revoked", sessionId: session.sessionId, userId: session.userId };
  const expired = await expiredReason(row);
  if (expired) return { session: null, reason: expired, sessionId: session.sessionId, userId: session.userId };
  await touch(row);
  session.email = user.email;
  session.firstName = user.firstName;
  return { session: session as AuthenticatedSession };
}

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
 * login, which seals a session id. See authenticate for the full rules.
 */
export async function requireSession(req?: NextRequest): Promise<AuthenticatedSession | null> {
  return (await authenticate(req)).session;
}
