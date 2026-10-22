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

const LOGIN_WINDOW_MS = 15 * 60_000;
/** One client's guesses at one account. */
const ATTEMPTS_PER_ACCOUNT_AND_CLIENT = 5;
/** One client's sign-in attempts at any accounts; the passkey sign-in spends the same budget. */
const ATTEMPTS_PER_CLIENT = 20;
/** Wrong guesses at one account, from anywhere, that are still answered at once. */
export const SLOWDOWN_FREE_FAILURES = 10;
export const SLOWDOWN_STEP_MS = 250;
export const SLOWDOWN_MAX_MS = 5_000;

/**
 * How long a wrong answer is held back once an account has been guessed at
 * from several places. It slows a guesser and never refuses anyone: a hard
 * limit on the account itself would let any stranger lock the owner out.
 */
export function accountSlowDownMs(failures: number): number {
  return Math.min(SLOWDOWN_MAX_MS, Math.max(0, failures - SLOWDOWN_FREE_FAILURES) * SLOWDOWN_STEP_MS);
}

async function authenticate(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  const valid = await bcrypt.compare(password, user?.passwordHash || DUMMY_PASSWORD_HASH);
  if (!user) return null;
  return valid ? user : null;
}

/**
 * Shared by /api/auth/login and /api/auth/token: same schema, same rate-limit
 * buckets, same dummy-hash timing for an unknown email, same messages.
 *
 * The counters live in this process and start over with it. Persisting them
 * would take a table; what a restart buys a guesser is one more window of the
 * per-client limits, and nobody but the owner can restart the server.
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

  // The account's guesses are counted per client: a stranger who uses up the
  // guesses of an email address from their own address cannot lock out the
  // owner, whose guesses come from another one.
  const client = requestClientKey(req);
  const accountRateKey = `login:account:${opaqueRateKey(`${email}\n${client}`)}`;
  const ipRate = consumeRateLimit(`login:ip:${client}`, ATTEMPTS_PER_CLIENT, LOGIN_WINDOW_MS);
  const accountRate = consumeRateLimit(accountRateKey, ATTEMPTS_PER_ACCOUNT_AND_CLIENT, LOGIN_WINDOW_MS);
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
    // Counted only after the per-client limits let the attempt through, so one
    // client can add no more than its own few guesses to the account's tally.
    const failures = consumeRateLimit(
      `login:failures:${opaqueRateKey(email)}`,
      SLOWDOWN_FREE_FAILURES,
      LOGIN_WINDOW_MS
    );
    const wait = accountSlowDownMs(failures.count);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
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
