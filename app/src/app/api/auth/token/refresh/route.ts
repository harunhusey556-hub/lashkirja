import { NextRequest, NextResponse } from "next/server";
import { authenticate, type AuthFailureReason } from "@/lib/session";
import { bearerTokenFrom, sealBearerToken } from "@/lib/auth-credential";
import { checkRefreshSignature } from "@/lib/device-key";
import { consumeRateLimit } from "@/lib/rate-limit";
import { rejectCrossSite } from "@/lib/http-security";

/** The app reads `reason` to tell "sign in again" ("device", "reuse", ...) from a plain retry. */
function unauthorized(reason: AuthFailureReason | "device") {
  return NextResponse.json(
    { error: { code: "UNAUTHORIZED", message: "Kirjautuminen vaaditaan", reason } },
    { status: 401 }
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
 * authenticate revokes the session ("reuse"). Inside the grace, the previous
 * generation is a sibling refresh that raced the one whose token is already
 * in use (the web client sends one per resume event): it gets that same next
 * token again.
 *
 * A session bound to a device key additionally needs that device's
 * signature over the token, so a stolen token alone cannot be refreshed. A
 * right signature made on a clock more than the allowed skew off gets a 409
 * with the server's time to sign again on, not a sign-out.
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
  if (!auth.session) return unauthorized(auth.reason);
  const session = auth.session;
  if (session.kind !== "bearer" || !session.sessionId) return unauthorized("invalid");

  // One behind the row passes authenticate only inside the grace; presented + 1 is then the
  // generation already committed, the token the sibling refresh got.
  const presented = session.credentialGeneration ?? 0;

  if (session.deviceKey) {
    const token = bearerTokenFrom(req.headers.get("authorization"));
    const signature =
      token === null
        ? "bad"
        : checkRefreshSignature(
            session.deviceKey,
            token,
            req.headers.get("x-lk-device-time"),
            req.headers.get("x-lk-device-signature")
          );
    if (signature === "skew") {
      return NextResponse.json(
        { error: "Laitteen kello on väärässä.", code: "DEVICE_CLOCK", serverTime: Math.floor(Date.now() / 1000) },
        { status: 409 }
      );
    }
    if (signature !== "ok") return unauthorized("device");
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
