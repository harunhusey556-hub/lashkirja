import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { guardWrite } from "@/lib/http-security";
import { consumeRateLimit, opaqueRateKey, requestClientKey } from "@/lib/rate-limit";
import {
  AccountSecurityError,
  accountLinkBase,
  normalizeLoginEmail,
  notifyPasswordChanged,
  resetPasswordWithCode,
  resetPasswordWithToken,
} from "@/lib/account-security";
import { PASSWORD_MAX } from "@/lib/session-policy";

const tokenSchema = z.object({
  token: z.string().trim().min(20).max(200),
  password: z.string().min(1).max(PASSWORD_MAX),
});

const codeSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  code: z.string().trim().max(20),
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
  const raw = await req.json().catch(() => null);
  const byToken = tokenSchema.safeParse(raw);
  const byCode = byToken.success ? null : codeSchema.safeParse(raw);
  if (!byToken.success && !byCode?.success) {
    return NextResponse.json({ error: "Virheellinen pyyntö" }, { status: 400 });
  }
  try {
    let userId: string;
    if (byToken.success) {
      userId = await resetPasswordWithToken(byToken.data.token, byToken.data.password);
    } else {
      const { email, code, password } = byCode!.data!;
      const account = consumeRateLimit(
        `password-reset-code:${opaqueRateKey(normalizeLoginEmail(email))}`,
        10,
        60 * 60_000
      );
      if (!account.allowed) {
        return NextResponse.json(
          { error: "Liian monta yritystä. Yritä myöhemmin uudelleen." },
          { status: 429 }
        );
      }
      userId = await resetPasswordWithCode(email, code, password);
    }
    notifyPasswordChanged(userId, accountLinkBase(req.nextUrl.origin));
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof AccountSecurityError) {
      return NextResponse.json(error.body(), { status: error.status });
    }
    throw error;
  }
}
