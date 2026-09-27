import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { guardWrite } from "@/lib/http-security";
import { consumeRateLimit, opaqueRateKey, requestClientKey } from "@/lib/rate-limit";
import { issuePasswordReset, normalizeLoginEmail, sendAccountMail } from "@/lib/account-security";
import { queueRecoveryRequest } from "@/lib/account-requests";

const bodySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
});

const GENERIC =
  "Jos tilille voidaan lähettää postia, palautuslinkki on matkalla. Muuten pyydä palautus tuesta. Pyyntö näkyy Tietosuojassa, kun kirjaudut.";

function resetLink(req: NextRequest, token: string): string {
  const configured = process.env.APP_ORIGIN?.trim().replace(/\/$/, "");
  const base = configured || req.nextUrl.origin;
  return `${base}/palauta-salasana?token=${encodeURIComponent(token)}`;
}

export async function POST(req: NextRequest) {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Sähköposti ei ole kelvollinen." }, { status: 400 });
  }
  const email = normalizeLoginEmail(parsed.data.email);
  const ip = consumeRateLimit(`password-forgot:ip:${requestClientKey(req)}`, 10, 60 * 60_000);
  const account = consumeRateLimit(`password-forgot:${opaqueRateKey(email)}`, 5, 60 * 60_000);
  if (!ip.allowed || !account.allowed) {
    return NextResponse.json(
      { error: "Liian monta yritystä. Yritä myöhemmin uudelleen." },
      { status: 429 }
    );
  }

  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (user) {
    const token = await issuePasswordReset(user.id);
    const mailed = await sendAccountMail(user.id, {
      to: email,
      subject: "LashKirjan salasanan palautus",
      text: `Avaa linkki 30 minuutin kuluessa ja valitse uusi salasana:\n${resetLink(req, token)}\n\nJos et pyytänyt palautusta, voit ohittaa tämän viestin.`,
    });
    if (!mailed) await queueRecoveryRequest(user.id);
  }
  return NextResponse.json({ ok: true, message: GENERIC });
}
