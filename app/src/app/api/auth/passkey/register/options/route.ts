import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { guardWrite } from "@/lib/http-security";
import { consumeRateLimit } from "@/lib/rate-limit";
import { createRegistrationOptions } from "@/lib/passkey";
import { noStore, passkeyErrorResponse } from "@/lib/passkey-session";
import { AccountSecurityError, confirmCurrentPassword } from "@/lib/account-security";
import { PASSWORD_MAX } from "@/lib/session-policy";

const bodySchema = z.object({ currentPassword: z.string().min(1).max(PASSWORD_MAX) });

/**
 * Adding a passkey adds a way to sign in, so a session alone is not enough:
 * the caller confirms the current password here (the same check as a
 * password or email change). The registration challenge is only minted after
 * that check and lives PASSKEY_CHALLENGE_TTL_MS (5 min), so the confirmation
 * is valid for exactly one registration within five minutes.
 */

export async function POST(req: NextRequest) {
  try {
    const blocked = guardWrite(req, 4 * 1024);
    if (blocked) return blocked;
    const session = await requireSession(req);
    if (!session) return noStore(NextResponse.json({ error: "Kirjautuminen vaaditaan" }, { status: 401 }));

    // Also the limit on password guesses through this route.
    const rate = consumeRateLimit(`passkey:register:${session.userId}`, 10, 15 * 60_000);
    if (!rate.allowed) {
      return noStore(
        NextResponse.json(
          { error: "Liian monta yritystä. Yritä hetken kuluttua uudelleen." },
          { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } }
        )
      );
    }

    const parsed = bodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return noStore(NextResponse.json({ error: "Kirjoita nykyinen salasana." }, { status: 400 }));
    }
    try {
      await confirmCurrentPassword(session.userId, parsed.data.currentPassword);
    } catch (error) {
      if (error instanceof AccountSecurityError) {
        return noStore(NextResponse.json({ error: error.message }, { status: error.status }));
      }
      throw error;
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
