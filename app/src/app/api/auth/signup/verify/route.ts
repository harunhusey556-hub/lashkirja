import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { consumeRateLimit, opaqueRateKey, requestClientKey } from "@/lib/rate-limit";
import {
  AccountSecurityError,
  accountLinkBase,
  normalizeLoginEmail,
  openAuthSession,
  sendAccountMail,
} from "@/lib/account-security";
import { sealBearerToken } from "@/lib/auth-credential";
import { rejectSignupRequest, verifySignup, welcomeMail } from "@/lib/signup";
import { PASSWORD_MAX } from "@/lib/session-policy";

const bodySchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  code: z.string().trim().max(20),
  password: z.string().min(1).max(PASSWORD_MAX),
  device: z.string().max(40).optional(),
});

/** Code in, signed-in app out: the success answer is exactly the one of POST /api/auth/token. */
export async function POST(req: NextRequest) {
  const blocked = rejectSignupRequest(req, false);
  if (blocked) return blocked;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Virheellinen pyyntö" }, { status: 400 });
  }
  const email = normalizeLoginEmail(parsed.data.email);
  const ip = consumeRateLimit(`signup-verify:ip:${requestClientKey(req)}`, 10, 60 * 60_000);
  const account = consumeRateLimit(`signup-verify:${opaqueRateKey(email)}`, 10, 60 * 60_000);
  if (!ip.allowed || !account.allowed) {
    return NextResponse.json(
      { error: "Liian monta yritystä. Yritä myöhemmin uudelleen." },
      {
        status: 429,
        headers: { "Retry-After": String(Math.max(ip.retryAfterSeconds, account.retryAfterSeconds)) },
      }
    );
  }
  try {
    const user = await verifySignup(email, parsed.data.code, parsed.data.password);
    const device = parsed.data.device === "ios-app" ? ("ios-app" as const) : undefined;
    const row = await openAuthSession(user.id, req.headers.get("user-agent"), device);
    const sealed = await sealBearerToken({
      userId: user.id,
      email: user.email,
      firstName: user.firstName,
      sessionId: row.id,
    });
    // The account exists now; a welcome that cannot be sent is only logged.
    const linkBase = accountLinkBase(req.nextUrl.origin);
    if (linkBase) {
      await sendAccountMail(user.id, welcomeMail(user.email, user.firstName, linkBase)).catch((error) => {
        console.error("Welcome mail failed", error);
        return false;
      });
    }
    return NextResponse.json({
      token: sealed.token,
      tokenType: "Bearer",
      expiresAt: sealed.expiresAt.toISOString(),
      user: { userId: user.id, email: user.email, firstName: user.firstName },
    });
  } catch (error) {
    if (error instanceof AccountSecurityError) {
      return NextResponse.json(error.body(), { status: error.status });
    }
    throw error;
  }
}
