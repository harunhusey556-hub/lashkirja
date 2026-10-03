import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { guardWrite } from "@/lib/http-security";
import { consumeRateLimit } from "@/lib/rate-limit";
import { AccountSecurityError, accountLinkBase, changePassword, notifyPasswordChanged } from "@/lib/account-security";
import { PASSWORD_MAX } from "@/lib/session-policy";

const bodySchema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX),
  newPassword: z.string().min(1).max(PASSWORD_MAX),
});

export async function POST(req: NextRequest) {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });

  const limit = consumeRateLimit(`password-change:${session.userId}`, 5, 15 * 60_000);
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
    await changePassword(
      session.userId,
      session.sessionId,
      parsed.data.currentPassword,
      parsed.data.newPassword
    );
    notifyPasswordChanged(session.userId, accountLinkBase(req.nextUrl.origin));
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof AccountSecurityError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
