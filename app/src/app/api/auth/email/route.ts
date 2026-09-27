import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { guardWrite } from "@/lib/http-security";
import { consumeRateLimit } from "@/lib/rate-limit";
import { AccountSecurityError, requestEmailChange, sendAccountMail } from "@/lib/account-security";

const bodySchema = z.object({
  email: z.string().trim().max(254),
  currentPassword: z.string().min(1).max(1024),
});

function confirmLink(req: NextRequest, token: string): string {
  const configured = process.env.APP_ORIGIN?.trim().replace(/\/$/, "");
  const base = configured || req.nextUrl.origin;
  return `${base}/vahvista-sahkoposti?token=${encodeURIComponent(token)}`;
}

export async function POST(req: NextRequest) {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  const session = await requireSession(req);
  if (!session) return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  const limit = consumeRateLimit(`email-change:${session.userId}`, 5, 60 * 60_000);
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
    const pending = await requestEmailChange(
      session.userId,
      parsed.data.email,
      parsed.data.currentPassword
    );
    const delivered = await sendAccountMail(session.userId, {
      to: pending.email,
      subject: "Vahvista LashKirjan sähköposti",
      text: `Vahvista uusi kirjautumissähköposti linkistä. Vanha osoite toimii, kunnes vahvistat:\n${confirmLink(req, pending.token)}`,
    });
    return NextResponse.json({
      ok: true,
      pendingEmail: pending.email,
      delivered,
      message: delivered
        ? "Vahvistuslinkki lähti uuteen osoitteeseen. Nykyinen sähköposti pysyy, kunnes linkki avataan."
        : "Uutta osoitetta ei vaihdettu. Vahvistusviestiä ei voitu lähettää, koska lähetyspostia ei ole yhdistetty. Pyydä linkki tuesta.",
    });
  } catch (error) {
    if (error instanceof AccountSecurityError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
