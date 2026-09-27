import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { guardWrite } from "@/lib/http-security";
import { consumeRateLimit, requestClientKey } from "@/lib/rate-limit";
import { AccountSecurityError, resetPasswordWithToken } from "@/lib/account-security";
import { PASSWORD_MAX } from "@/lib/session-policy";

const bodySchema = z.object({
  token: z.string().trim().min(20).max(200),
  password: z.string().min(1).max(PASSWORD_MAX),
});

export async function POST(req: NextRequest) {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  const limit = consumeRateLimit(`password-reset:${requestClientKey(req)}`, 10, 60 * 60_000);
  if (!limit.allowed) {
    return NextResponse.json(
      { error: "Liian monta yritystä. Yritä myöhemmin uudelleen." },
      { status: 429 }
    );
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Virheellinen pyyntö" }, { status: 400 });
  }
  try {
    await resetPasswordWithToken(parsed.data.token, parsed.data.password);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof AccountSecurityError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
