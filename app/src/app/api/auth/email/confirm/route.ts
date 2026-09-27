import { NextRequest, NextResponse } from "next/server";
import { getIronSession } from "iron-session";
import { z } from "zod";
import { sessionOptions, type SessionData } from "@/lib/session";
import { guardWrite } from "@/lib/http-security";
import { consumeRateLimit, requestClientKey } from "@/lib/rate-limit";
import { AccountSecurityError, confirmEmailChange } from "@/lib/account-security";

const bodySchema = z.object({
  token: z.string().trim().min(20).max(200),
});

export async function POST(req: NextRequest) {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  const limit = consumeRateLimit(`email-confirm:${requestClientKey(req)}`, 10, 60 * 60_000);
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
    const confirmed = await confirmEmailChange(parsed.data.token);
    const res = NextResponse.json({ ok: true, email: confirmed.email });
    const session = await getIronSession<SessionData>(req, res, sessionOptions);
    if (session.userId === confirmed.userId) {
      session.email = confirmed.email;
      await session.save();
    }
    return res;
  } catch (error) {
    if (error instanceof AccountSecurityError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
