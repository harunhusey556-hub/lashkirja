import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { guardWrite } from "@/lib/http-security";
import { consumeRateLimit } from "@/lib/rate-limit";
import { createRegistrationOptions } from "@/lib/passkey";
import { noStore, passkeyErrorResponse } from "@/lib/passkey-session";

export async function POST(req: NextRequest) {
  try {
    const blocked = guardWrite(req, 4 * 1024);
    if (blocked) return blocked;
    const session = await requireSession(req);
    if (!session) return noStore(NextResponse.json({ error: "Kirjautuminen vaaditaan" }, { status: 401 }));

    const rate = consumeRateLimit(`passkey:register:${session.userId}`, 20, 15 * 60_000);
    if (!rate.allowed) {
      return noStore(
        NextResponse.json(
          { error: "Liian monta yritystä. Yritä hetken kuluttua uudelleen." },
          { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } }
        )
      );
    }

    const result = await createRegistrationOptions({
      id: session.userId,
      email: session.email,
      firstName: session.firstName,
    });
    return noStore(NextResponse.json(result));
  } catch (error) {
    return passkeyErrorResponse(error, "Passkey registration options failed");
  }
}
