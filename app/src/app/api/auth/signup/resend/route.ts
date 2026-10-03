import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { consumeRateLimit, opaqueRateKey, requestClientKey } from "@/lib/rate-limit";
import { deliverInBackground, normalizeLoginEmail } from "@/lib/account-security";
import { sendPlatformMail } from "@/lib/mailer";
import { rejectSignupRequest, renewSignupCode, signupCodeMail } from "@/lib/signup";

const bodySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
});

/** A new code for a pending sign-up. The answer is the same whether or not one exists. */
export async function POST(req: NextRequest) {
  const blocked = rejectSignupRequest(req, true);
  if (blocked) return blocked;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Sähköposti ei ole kelvollinen." }, { status: 400 });
  }
  const email = normalizeLoginEmail(parsed.data.email);
  const key = opaqueRateKey(email);
  const limits = [
    consumeRateLimit(`signup-resend:ip:${requestClientKey(req)}`, 20, 60 * 60_000),
    consumeRateLimit(`signup-resend:${key}`, 5, 60 * 60_000),
    consumeRateLimit(`signup-resend:minute:${key}`, 1, 60_000),
  ];
  const refused = limits.filter((limit) => !limit.allowed);
  if (refused.length > 0) {
    return NextResponse.json(
      { error: "Liian monta yritystä. Yritä myöhemmin uudelleen." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.max(...refused.map((limit) => limit.retryAfterSeconds))) },
      }
    );
  }
  // After the answer, and the answer is neutral: neither its content nor its
  // timing may tell which addresses have a pending sign-up.
  deliverInBackground("Sign-up code resend failed", async () => {
    const code = await renewSignupCode(email);
    if (code) await sendPlatformMail(signupCodeMail(email, code));
  });
  return NextResponse.json({ ok: true, mailConfigured: true });
}
