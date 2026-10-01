import bcrypt from "bcryptjs";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { CLOSED_LOGIN_MESSAGE } from "@/lib/account-copy";
import {
  clearRateLimit,
  consumeRateLimit,
  opaqueRateKey,
  requestClientKey,
} from "@/lib/rate-limit";

export const credentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(1024),
});

export const DUMMY_PASSWORD_HASH =
  "$2b$10$pY981y3NyIOQ/8tQ3VpIOeUi8YLqkZ5Ut.ZveoRZe6crXBQXdzdDG";

export interface AuthenticatedUser {
  id: string;
  email: string;
  firstName: string;
}

export type CredentialsCheck =
  | { ok: true; user: AuthenticatedUser }
  | { ok: false; status: 400 | 401 | 403 | 429; error: string; retryAfter?: number };

async function authenticate(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  const valid = await bcrypt.compare(password, user?.passwordHash || DUMMY_PASSWORD_HASH);
  if (!user) return null;
  return valid ? user : null;
}

/**
 * Shared by /api/auth/login and /api/auth/token: same schema, same rate-limit
 * buckets, same dummy-hash timing for an unknown email, same messages.
 */
export async function checkCredentials(
  req: NextRequest,
  emailRaw: string,
  passwordRaw: string
): Promise<CredentialsCheck> {
  const credentials = credentialsSchema.safeParse({ email: emailRaw, password: passwordRaw });
  if (!credentials.success) {
    return { ok: false, status: 400, error: "Sähköposti ja salasana vaaditaan" };
  }
  const { email, password } = credentials.data;

  const accountRateKey = `login:account:${opaqueRateKey(email)}`;
  const ipRate = consumeRateLimit(`login:ip:${requestClientKey(req)}`, 20, 15 * 60_000);
  const accountRate = consumeRateLimit(accountRateKey, 5, 15 * 60_000);
  if (!ipRate.allowed || !accountRate.allowed) {
    const retryAfter = Math.max(ipRate.retryAfterSeconds, accountRate.retryAfterSeconds);
    return {
      ok: false,
      status: 429,
      error: "Liian monta kirjautumisyritystä. Yritä myöhemmin uudelleen.",
      retryAfter,
    };
  }

  const user = await authenticate(email, password);
  if (!user) {
    return {
      ok: false,
      status: 401,
      error: "Sähköposti tai salasana on väärin. Tarkista ja yritä uudelleen.",
    };
  }
  if (user.accessDisabledAt) {
    return {
      ok: false,
      status: 403,
      error: CLOSED_LOGIN_MESSAGE,
    };
  }

  clearRateLimit(accountRateKey);
  return { ok: true, user: { id: user.id, email: user.email, firstName: user.firstName } };
}
