import { NextRequest, NextResponse } from "next/server";
import { rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { consumeRateLimit, requestClientKey } from "@/lib/rate-limit";
import { createAuthenticationOptions } from "@/lib/passkey";
import { noStore, passkeyErrorResponse } from "@/lib/passkey-session";

/** Unauthenticated, usernameless: the options never name an account or a credential. */
export async function POST(req: NextRequest) {
  try {
    const blocked = rejectCrossSite(req) ?? rejectOversizedContentLength(req, 4 * 1024);
    if (blocked) return blocked;
    const rate = consumeRateLimit(`passkey:options:ip:${requestClientKey(req)}`, 30, 15 * 60_000);
    if (!rate.allowed) {
      return noStore(
        NextResponse.json(
          { error: "Liian monta kirjautumisyritystä. Yritä myöhemmin uudelleen." },
          { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } }
        )
      );
    }
    const { challengeId, options } = await createAuthenticationOptions();
    return noStore(NextResponse.json({ challengeId, options }));
  } catch (error) {
    return passkeyErrorResponse(error, "Passkey authentication options failed");
  }
}
