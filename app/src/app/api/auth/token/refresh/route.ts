import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { sealBearerToken } from "@/lib/auth-credential";
import { consumeRateLimit } from "@/lib/rate-limit";
import { rejectCrossSite } from "@/lib/http-security";

/**
 * Refresh is refused once the AuthSession row is older than this, even
 * though the presented token itself may still unseal successfully. Without
 * this, a single stolen token could be refreshed forever: each refresh
 * mints a brand-new 30-day token for the same row without invalidating the
 * one just presented (final review I3), so nothing ever forced re-entry of
 * the password. 90 days means a device used at least monthly is asked to
 * log in again about four times a year (in line with plan Decision 3,
 * which explicitly accepts "never ask for the password if used monthly");
 * a leaked token's usable lifetime is bounded to a few months instead of
 * indefinitely. No migration needed - AuthSession.createdAt already exists.
 *
 * This does NOT change how a *non-refreshed* token authenticates: that is
 * still bounded purely by the token's own iron-sealed TTL
 * (TOKEN_TTL_SECONDS, 30 days from the seal, checked in readCredential's
 * unsealData call), independent of the row's age. Only *refreshing* past
 * this point is refused, in this route alone - requireSession() itself is
 * unchanged, so a still-valid original token keeps working right up to its
 * own 30-day expiry even if the row is far older than
 * MAX_AUTH_SESSION_AGE_MS. Real rotation (revoking the presented token the
 * moment a new one is issued) needs a migration (a tokenGeneration column)
 * and is deferred - see decision notes.
 */
export const MAX_AUTH_SESSION_AGE_MS = 90 * 24 * 60 * 60 * 1000;

function unauthorized() {
  return NextResponse.json(
    { error: { code: "UNAUTHORIZED", message: "Kirjautuminen vaaditaan" } },
    { status: 401 }
  );
}

/**
 * Issues a fresh bearer token for the SAME AuthSession row (does not open a
 * new one). requireSession() does the real work: an expired-but-still
 * bearer-shaped token, a revoked session row, or a disabled account all
 * come back here as `null`.
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

  const session = await requireSession(req);
  if (!session || session.kind !== "bearer" || !session.sessionId) return unauthorized();

  if (
    session.authSessionCreatedAt &&
    Date.now() - session.authSessionCreatedAt.getTime() > MAX_AUTH_SESSION_AGE_MS
  ) {
    return unauthorized();
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
  });

  return NextResponse.json({
    token: sealed.token,
    tokenType: "Bearer",
    expiresAt: sealed.expiresAt.toISOString(),
    user: { userId: session.userId, email: session.email, firstName: session.firstName },
  });
}
