import { NextRequest, NextResponse } from "next/server";
import { authenticate, type AuthFailureReason } from "@/lib/session";
import { bearerTokenFrom, sealBearerToken } from "@/lib/auth-credential";
import { verifyRefreshSignature } from "@/lib/device-key";
import { consumeRateLimit } from "@/lib/rate-limit";
import { rejectCrossSite } from "@/lib/http-security";
import { prisma } from "@/lib/db";

/** The app reads `reason` to tell "sign in again" ("device", "reuse", ...) from a plain retry. */
function unauthorized(reason: AuthFailureReason | "device" | "reuse") {
  return NextResponse.json(
    { error: { code: "UNAUTHORIZED", message: "Kirjautuminen vaaditaan", reason } },
    { status: 401 }
  );
}

/** A token generation that was already replaced is back in play: someone holds a copy. Kill the whole family. */
async function revokeForReuse(sessionId: string, userId: string, presented: number, committed: number) {
  await prisma.authSession.updateMany({
    where: { id: sessionId, userId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: "reuse" },
  });
  // Ids and generations only, never the token.
  console.warn(
    `[auth] refresh token reuse: session=${sessionId} user=${userId} presentedGen=${presented} currentGen=${committed}`
  );
}

/**
 * Issues the next bearer token for the SAME AuthSession row (does not open a
 * new one). authenticate() does the real work: an expired-but-still
 * bearer-shaped token, a revoked, idle or too old session row, or a disabled
 * account all come back here as a failure with a reason.
 *
 * The new token is generation + 1 and is NOT written to the row here: it
 * commits when the device first uses it, so a refresh response lost on the
 * way never leaves the device holding a token the server has moved past.
 * Presenting a generation the row has already moved past (beyond the short
 * grace for requests in flight) means a copy of the token exists elsewhere:
 * the session is revoked ("reuse").
 *
 * A session bound to a device key additionally needs that device's
 * signature over the token, so a stolen token alone cannot be refreshed.
 *
 * Final review I1: this must accept a bearer credential ONLY, never the web
 * cookie. The web cookie is HttpOnly precisely so injected script cannot
 * carry the session away with it; letting a cookie mint a portable 30-day
 * bearer token undoes that. `rejectCrossSite` is applied too, even though
 * `/api/auth/` is a public proxy prefix that skips it there - a
 * token-minting endpoint should not rely solely on CORS/credentials
 * behavior to stop a cross-site POST from riding a same-site cookie.
 */
export async function POST(req: NextRequest) {
  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;

  const auth = await authenticate(req);
  if (!auth.session) {
    if (auth.reason === "rotated" && auth.sessionId && auth.userId) {
      await revokeForReuse(auth.sessionId, auth.userId, auth.credentialGeneration ?? 0, auth.tokenGeneration ?? 0);
      return unauthorized("reuse");
    }
    return unauthorized(auth.reason);
  }
  const session = auth.session;
  if (session.kind !== "bearer" || !session.sessionId) return unauthorized("invalid");

  const presented = session.credentialGeneration ?? 0;
  const committed = session.tokenGeneration ?? 0;
  if (presented < committed) {
    // authenticate let it through only for the grace; refreshing from it is still a replay.
    await revokeForReuse(session.sessionId, session.userId, presented, committed);
    return unauthorized("reuse");
  }

  if (session.deviceKey) {
    const token = bearerTokenFrom(req.headers.get("authorization"));
    const valid =
      token !== null &&
      verifyRefreshSignature(
        session.deviceKey,
        token,
        req.headers.get("x-lk-device-time"),
        req.headers.get("x-lk-device-signature")
      );
    if (!valid) return unauthorized("device");
  }

  const limit = consumeRateLimit(`token-refresh:${session.sessionId}`, 30, 60 * 60_000);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Liian monta pyyntöä. Yritä myöhemmin uudelleen." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  const sealed = await sealBearerToken({
    userId: session.userId,
    email: session.email,
    firstName: session.firstName,
    sessionId: session.sessionId,
    gen: presented + 1,
    sessionStartedAt: session.sessionStartedAt,
  });

  return NextResponse.json({
    token: sealed.token,
    tokenType: "Bearer",
    expiresAt: sealed.expiresAt.toISOString(),
    user: { userId: session.userId, email: session.email, firstName: session.firstName },
  });
}
