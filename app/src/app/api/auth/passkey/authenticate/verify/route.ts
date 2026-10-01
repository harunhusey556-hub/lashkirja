import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { isAppClientOrigin } from "@/lib/app-origins";
import { consumeRateLimit, requestClientKey } from "@/lib/rate-limit";
import { verifyAuthentication } from "@/lib/passkey";
import { issuePasskeySession, noStore, passkeyErrorResponse } from "@/lib/passkey-session";

const bodySchema = z.object({
  challengeId: z.string().min(1).max(64),
  response: z.unknown(),
  transport: z.enum(["bearer", "cookie"]),
  device: z.literal("ios-app").optional(),
});

/**
 * Passkey sign-in. Shares the password login's per-IP bucket (20 per 15 min),
 * so alternating the two methods does not double an attacker's budget. On
 * success it issues exactly the session the password login issues.
 */
export async function POST(req: NextRequest) {
  try {
    const blocked = rejectCrossSite(req) ?? rejectOversizedContentLength(req, 64 * 1024);
    if (blocked) return blocked;

    const ipRate = consumeRateLimit(`login:ip:${requestClientKey(req)}`, 20, 15 * 60_000);
    if (!ipRate.allowed) {
      return noStore(
        NextResponse.json(
          { error: "Liian monta kirjautumisyritystä. Yritä myöhemmin uudelleen." },
          { status: 429, headers: { "Retry-After": String(ipRate.retryAfterSeconds) } }
        )
      );
    }

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return noStore(NextResponse.json({ error: "Virheellinen pyyntö" }, { status: 400 }));
    }
    // The bundled app never gets a cookie: its requests carry no ambient
    // credentials and readCredential ignores cookies from app origins.
    if (parsed.data.transport === "cookie" && isAppClientOrigin(req.headers.get("origin"))) {
      return noStore(NextResponse.json({ error: "Virheellinen pyyntö" }, { status: 400 }));
    }

    const result = await verifyAuthentication({
      challengeId: parsed.data.challengeId,
      response: parsed.data.response,
    });
    if (!result.ok) {
      return noStore(NextResponse.json({ error: result.error }, { status: result.status }));
    }
    return issuePasskeySession(req, result.user, parsed.data.transport, parsed.data.device);
  } catch (error) {
    return passkeyErrorResponse(error, "Passkey sign-in failed");
  }
}
