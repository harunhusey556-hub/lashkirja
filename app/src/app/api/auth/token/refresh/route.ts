import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { sealBearerToken } from "@/lib/auth-credential";
import { consumeRateLimit } from "@/lib/rate-limit";

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
 */
export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session || !session.sessionId) return unauthorized();

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
