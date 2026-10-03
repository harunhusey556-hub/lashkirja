import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { consumeRateLimit, opaqueRateKey, requestClientKey } from "@/lib/rate-limit";
import { accountLinkBase, normalizeLoginEmail } from "@/lib/account-security";
import { sendPlatformMail } from "@/lib/mailer";
import { PASSWORD_MAX, passwordProblem } from "@/lib/session-policy";
import {
  SIGNUP_UNAVAILABLE,
  discardPendingSignup,
  rejectSignupRequest,
  signupCodeMail,
  signupExistingMail,
  startSignup,
} from "@/lib/signup";

const bodySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().max(PASSWORD_MAX),
  firstName: z.string().trim().min(1).max(100),
});

function badField(field: PropertyKey | undefined): string {
  if (field === "firstName") return "Etunimi puuttuu.";
  if (field === "password") return "Salasana on liian pitkä.";
  return "Sähköposti ei ole kelvollinen.";
}

export async function POST(req: NextRequest) {
  const blocked = rejectSignupRequest(req, true);
  if (blocked) return blocked;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: badField(parsed.error.issues[0]?.path[0]) }, { status: 400 });
  }
  const email = normalizeLoginEmail(parsed.data.email);
  const ip = consumeRateLimit(`signup-start:ip:${requestClientKey(req)}`, 20, 60 * 60_000);
  const account = consumeRateLimit(`signup-start:${opaqueRateKey(email)}`, 5, 60 * 60_000);
  if (!ip.allowed || !account.allowed) {
    return NextResponse.json(
      { error: "Liian monta yritystä. Yritä myöhemmin uudelleen." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.max(ip.retryAfterSeconds, account.retryAfterSeconds)) },
      }
    );
  }
  const problem = passwordProblem(parsed.data.password);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });

  const started = await startSignup({
    email,
    password: parsed.data.password,
    firstName: parsed.data.firstName,
  });
  try {
    // An address that already has an account gets a notice instead of a code,
    // and the caller gets the very same answer either way.
    await sendPlatformMail(
      started.kind === "pending"
        ? signupCodeMail(email, started.code)
        : signupExistingMail(email, accountLinkBase(req.nextUrl.origin))
    );
  } catch (error) {
    console.error("Sign-up mail failed", error);
    if (started.kind === "pending") await discardPendingSignup(email);
    return NextResponse.json({ error: SIGNUP_UNAVAILABLE }, { status: 503 });
  }
  return NextResponse.json({ ok: true, mailConfigured: true });
}
