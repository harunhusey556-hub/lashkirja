import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { guardWrite } from "@/lib/http-security";
import { consumeRateLimit, opaqueRateKey, requestClientKey } from "@/lib/rate-limit";
import {
  accountLinkBase,
  deliverInBackground,
  issuePasswordResetWithCode,
  normalizeLoginEmail,
  sendAccountMail,
} from "@/lib/account-security";
import { queueRecoveryRequest } from "@/lib/account-requests";
import { forgotPasswordMessage } from "@/lib/account-copy";
import { platformMailConfig } from "@/lib/mailer";

const bodySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
});


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

  // Lookup, reset row and mail all run after the answer, so an existing and
  // a missing account answer in the same time. A reset that cannot be mailed
  // (no mail path, or no trusted link origin) becomes a recovery request.
  const linkBase = accountLinkBase(req.nextUrl.origin);
  deliverInBackground("Password reset mail failed", async () => {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (!user) return;
    let mailed = false;
    if (linkBase) {
      const { token, code } = await issuePasswordResetWithCode(user.id);
      mailed = await sendAccountMail(user.id, {
        to: email,
        subject: "LashKirjan salasanan palautus",
        text: `Avaa linkki 30 minuutin kuluessa ja valitse uusi salasana:\n${linkBase}/palauta-salasana?token=${encodeURIComponent(token)}\n\nTai kirjoita sovellukseen koodi ${code}. Koodi on voimassa 30 minuuttia.\n\nJos et pyytänyt palautusta, voit ohittaa tämän viestin.`,
      });
    }
    if (!mailed) await queueRecoveryRequest(user.id);
  });
  // One answer for every address: it depends on whether this server can send
  // mail at all, so it neither claims a send that cannot happen nor tells
  // which accounts exist.
  const mailConfigured = platformMailConfig() !== null;
  return NextResponse.json({ ok: true, mailConfigured, message: forgotPasswordMessage(mailConfigured) });
}
