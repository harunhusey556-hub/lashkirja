import { createHash, randomBytes, randomInt, timingSafeEqual } from "crypto";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { findSenderAccount, platformMailConfig, sendMail, sendPlatformMail } from "@/lib/mailer";
import { passwordProblem, deviceLabel } from "@/lib/session-policy";
import { contactSupportPhrase } from "@/lib/account-copy";

const RESET_TTL_MS = 30 * 60 * 1000;
const EMAIL_TTL_MS = 24 * 60 * 60 * 1000;
/** Wrong emailed codes allowed per reset or sign-up before it is void. */
export const MAX_CODE_ATTEMPTS = 5;

export class AccountSecurityError extends Error {
  status: number;
  code?: string;
  attemptsLeft?: number;
  constructor(message: string, status: number, code?: string, attemptsLeft?: number) {
    super(message);
    this.name = "AccountSecurityError";
    this.status = status;
    this.code = code;
    this.attemptsLeft = attemptsLeft;
  }

  /** The JSON body a route answers with; `code` and `attemptsLeft` only when set. */
  body() {
    return {
      error: this.message,
      ...(this.code ? { code: this.code } : {}),
      ...(this.attemptsLeft !== undefined ? { attemptsLeft: this.attemptsLeft } : {}),
    };
  }
}

export function newAccountToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashAccountToken(token) };
}

export function hashAccountToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A 6-digit code for mail; the caller stores only hashEmailCode() of it. */
export function newEmailCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/** Scoped so one code hash cannot be replayed against another reset or sign-up. */
export function hashEmailCode(scope: string, code: string): string {
  return hashAccountToken(`${scope}:${code.trim()}`);
}

export function hashesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function openAuthSession(
  userId: string,
  userAgent: string | null,
  device?: "ios-app"
) {
  return prisma.authSession.create({
    data: { userId, label: deviceLabel(userAgent, device) },
  });
}

/** Password change/reset and device sign-out revoke sessions only; passkeys are credentials and stay (like Google/Apple/GitHub). */
export async function revokeAuthSessions(userId: string, exceptId?: string) {
  const now = new Date();
  await prisma.$transaction(revokeSessionWrites(userId, now, exceptId));
}

function revokeSessionWrites(userId: string, now: Date, exceptId?: string) {
  return [
    prisma.authSession.updateMany({
      where: {
        userId,
        revokedAt: null,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      data: { revokedAt: now },
    }),
    // Cookies that never received a session id cannot be found in AuthSession.
    // The cutoff is what makes those cookies fail requireSession.
    prisma.user.update({
      where: { id: userId },
      data: { legacySessionsRevokedAt: now },
    }),
  ] as [ReturnType<typeof prisma.authSession.updateMany>, ReturnType<typeof prisma.user.update>];
}

export async function listAuthSessions(userId: string, currentId?: string) {
  const rows = await prisma.authSession.findMany({
    where: { userId, revokedAt: null },
    orderBy: [{ lastSeenAt: "desc" }, { id: "desc" }],
    select: { id: true, label: true, createdAt: true, lastSeenAt: true },
  });
  return rows.map((row) => ({ ...row, current: row.id === currentId }));
}

/** Re-authentication for sensitive actions: throws 401 "Nykyinen salasana on väärä." */
export async function confirmCurrentPassword(userId: string, currentPassword: string): Promise<void> {
  await requireCurrentPassword(userId, currentPassword);
}

async function requireCurrentPassword(userId: string, currentPassword: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, passwordHash: true },
  });
  if (!user) throw new AccountSecurityError("Ei käyttäjää", 404);
  const valid = await bcrypt.compare(currentPassword, user.passwordHash);
  if (!valid) throw new AccountSecurityError("Nykyinen salasana on väärä.", 401);
  return user;
}

export async function changePassword(
  userId: string,
  currentSessionId: string | undefined,
  currentPassword: string,
  nextPassword: string
) {
  const problem = passwordProblem(nextPassword);
  if (problem) throw new AccountSecurityError(problem, 400);
  if (currentPassword === nextPassword) {
    throw new AccountSecurityError("Uuden salasanan on erottava nykyisestä.", 400);
  }
  await requireCurrentPassword(userId, currentPassword);
  const passwordHash = await bcrypt.hash(nextPassword, 12);
  await prisma.user.update({ where: { id: userId }, data: { passwordHash } });
  await revokeAuthSessions(userId, currentSessionId);
}

async function retireTokens(userId: string, purpose: string) {
  await prisma.accountToken.updateMany({
    where: { userId, purpose, usedAt: null },
    data: { usedAt: new Date() },
  });
}

export async function issuePasswordReset(userId: string) {
  return (await issuePasswordResetWithCode(userId)).token;
}

/** One reset row, two ways to use it: the link token and a 6-digit code typed in the app. */
export async function issuePasswordResetWithCode(userId: string) {
  await retireTokens(userId, "password_reset");
  const minted = newAccountToken();
  const code = newEmailCode();
  await prisma.accountToken.create({
    data: {
      userId,
      purpose: "password_reset",
      tokenHash: minted.tokenHash,
      codeHash: hashEmailCode(`reset:${userId}`, code),
      expiresAt: new Date(Date.now() + RESET_TTL_MS),
    },
  });
  return { token: minted.token, code };
}

export async function resetPasswordWithToken(token: string, nextPassword: string): Promise<string> {
  const problem = passwordProblem(nextPassword);
  if (problem) throw new AccountSecurityError(problem, 400);
  const row = await prisma.accountToken.findUnique({ where: { tokenHash: hashAccountToken(token) } });
  if (!row || row.purpose !== "password_reset" || row.usedAt || row.expiresAt.getTime() < Date.now()) {
    throw new AccountSecurityError("Linkki ei ole voimassa.", 400);
  }
  if (!hashesEqual(row.tokenHash, hashAccountToken(token))) {
    throw new AccountSecurityError("Linkki ei ole voimassa.", 400);
  }
  const passwordHash = await bcrypt.hash(nextPassword, 12);
  await prisma.$transaction([
    prisma.user.update({ where: { id: row.userId }, data: { passwordHash } }),
    prisma.accountToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
  ]);
  await revokeAuthSessions(row.userId);
  return row.userId;
}

const RESET_EXPIRED = "Palautuskoodi ei ole enää voimassa. Pyydä uusi.";

/** The code path of a reset: same effect as the link, and five wrong codes void the row (link too). */
export async function resetPasswordWithCode(
  emailRaw: string,
  code: string,
  nextPassword: string
): Promise<string> {
  const problem = passwordProblem(nextPassword);
  if (problem) throw new AccountSecurityError(problem, 400);
  const user = await prisma.user.findUnique({
    where: { email: normalizeLoginEmail(emailRaw) },
    select: { id: true },
  });
  const row = user
    ? await prisma.accountToken.findFirst({
        where: { userId: user.id, purpose: "password_reset", usedAt: null, codeHash: { not: null } },
        orderBy: { createdAt: "desc" },
      })
    : null;
  if (!row || !row.codeHash || row.expiresAt.getTime() < Date.now()) {
    throw new AccountSecurityError(RESET_EXPIRED, 410, "RESET_EXPIRED");
  }
  // The attempt is counted before the compare, so parallel guesses cannot
  // share one slot and the total stays at MAX_CODE_ATTEMPTS.
  const counted = await prisma.accountToken.updateMany({
    where: { id: row.id, usedAt: null, codeAttempts: { lt: MAX_CODE_ATTEMPTS } },
    data: { codeAttempts: { increment: 1 } },
  });
  if (counted.count !== 1) throw new AccountSecurityError(RESET_EXPIRED, 410, "RESET_EXPIRED");
  if (!hashesEqual(row.codeHash, hashEmailCode(`reset:${row.userId}`, code))) {
    const after = await prisma.accountToken.findUniqueOrThrow({ where: { id: row.id } });
    const attemptsLeft = Math.max(0, MAX_CODE_ATTEMPTS - after.codeAttempts);
    if (attemptsLeft === 0) {
      await prisma.accountToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
    }
    throw new AccountSecurityError("Koodi ei kelpaa.", 400, "RESET_CODE_INVALID", attemptsLeft);
  }
  const passwordHash = await bcrypt.hash(nextPassword, 12);
  await prisma.$transaction(async (db) => {
    const consumed = await db.accountToken.updateMany({
      where: { id: row.id, usedAt: null },
      data: { usedAt: new Date() },
    });
    if (consumed.count !== 1) throw new AccountSecurityError(RESET_EXPIRED, 410, "RESET_EXPIRED");
    await db.user.update({ where: { id: row.userId }, data: { passwordHash } });
  });
  await revokeAuthSessions(row.userId);
  return row.userId;
}

export function normalizeLoginEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function requestEmailChange(userId: string, nextEmailRaw: string, currentPassword: string) {
  const nextEmail = normalizeLoginEmail(nextEmailRaw);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(nextEmail) || nextEmail.length > 254) {
    throw new AccountSecurityError("Sähköposti ei ole kelvollinen.", 400);
  }
  const user = await requireCurrentPassword(userId, currentPassword);
  if (nextEmail === user.email) {
    throw new AccountSecurityError("Sähköposti on jo tämä.", 400);
  }
  const taken = await prisma.user.findUnique({ where: { email: nextEmail }, select: { id: true } });
  if (taken) throw new AccountSecurityError("Sähköposti on jo käytössä.", 409);
  await retireTokens(userId, "email_change");
  const minted = newAccountToken();
  await prisma.$transaction([
    prisma.accountToken.create({
      data: {
        userId,
        purpose: "email_change",
        tokenHash: minted.tokenHash,
        payload: nextEmail,
        expiresAt: new Date(Date.now() + EMAIL_TTL_MS),
      },
    }),
    prisma.user.update({ where: { id: userId }, data: { pendingEmail: nextEmail } }),
  ]);
  return { token: minted.token, email: nextEmail };
}

/** Undoes a requested change whose confirmation mail could not be sent: no token, no pending address. */
export async function cancelEmailChange(userId: string) {
  await prisma.$transaction([
    prisma.accountToken.updateMany({
      where: { userId, purpose: "email_change", usedAt: null },
      data: { usedAt: new Date() },
    }),
    prisma.user.update({ where: { id: userId }, data: { pendingEmail: null } }),
  ]);
}

export async function confirmEmailChange(token: string) {
  const row = await prisma.accountToken.findUnique({ where: { tokenHash: hashAccountToken(token) } });
  if (
    !row ||
    row.purpose !== "email_change" ||
    !row.payload ||
    row.usedAt ||
    row.expiresAt.getTime() < Date.now()
  ) {
    throw new AccountSecurityError("Linkki ei ole voimassa.", 400);
  }
  const taken = await prisma.user.findUnique({ where: { email: row.payload }, select: { id: true } });
  if (taken && taken.id !== row.userId) {
    throw new AccountSecurityError("Sähköposti on jo käytössä.", 409);
  }
  const previous = await prisma.user.findUniqueOrThrow({
    where: { id: row.userId },
    select: { email: true },
  });
  await prisma.$transaction([
    prisma.user.update({
      where: { id: row.userId },
      data: { email: row.payload, pendingEmail: null },
    }),
    prisma.accountToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
  ]);
  return { userId: row.userId, email: row.payload, previousEmail: previous.email };
}

/**
 * Password and email links. Prefer the platform mailbox (PLATFORM_SMTP_*),
 * which does not depend on the user's invoice SMTP. Fall back to that
 * mailbox only when the platform path is missing or fails.
 */
export async function sendAccountMail(
  userId: string,
  mail: { to: string; subject: string; text: string }
): Promise<boolean> {
  if (platformMailConfig()) {
    try {
      await sendPlatformMail(mail);
      return true;
    } catch (error) {
      console.error("Platform account mail failed", error);
    }
  }
  const account = await findSenderAccount(userId);
  if (!account) return false;
  try {
    await sendMail(account, mail);
    return true;
  } catch (error) {
    console.error("Account mail failed", error);
    return false;
  }
}

/** Public web origin for links in mail: APP_ORIGIN, else the request's own origin. */
export function accountLinkBase(requestOrigin: string): string {
  const configured = process.env.APP_ORIGIN?.trim().replace(/\/$/, "");
  return configured || requestOrigin;
}

/** "3.10.2026 klo 14.05" in Finnish local time. */
export function helsinkiTime(at: Date): string {
  return new Intl.DateTimeFormat("fi-FI", {
    timeZone: "Europe/Helsinki",
    day: "numeric",
    month: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
}

/** "m***@example.com": enough for the owner to recognise, not enough to copy. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

/**
 * Security notices are best-effort: the action has already committed, so a
 * mail that cannot be sent never turns the answer into an error. sendAccountMail
 * logs its own send failures; having no mail path at all is not an error.
 */
async function sendSecurityNotice(userId: string, mail: { to: string; subject: string; text: string }) {
  try {
    await sendAccountMail(userId, mail);
  } catch (error) {
    console.error("Security notice failed", { userId, subject: mail.subject }, error);
  }
}

export async function notifyPasswordChanged(userId: string, linkBase: string, at = new Date()) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  if (!user) return;
  await sendSecurityNotice(userId, {
    to: user.email,
    subject: "LashKirjan salasana vaihdettiin",
    text: `LashKirjan salasana vaihdettiin ${helsinkiTime(at)}. Jos se et ollut sinä: ${linkBase}/unohtunut-salasana`,
  });
}

export async function notifyEmailChanged(userId: string, previousEmail: string, nextEmail: string) {
  await sendSecurityNotice(userId, {
    to: previousEmail,
    subject: "LashKirjan kirjautumissähköposti vaihdettiin",
    text: `Kirjautumissähköposti vaihdettiin osoitteeseen ${maskEmail(nextEmail)}. Jos se et ollut sinä, ${contactSupportPhrase()}.`,
  });
}

export async function recordAccountRequest(userId: string, kind: "close" | "export", currentPassword: string) {
  await requireCurrentPassword(userId, currentPassword);
  return prisma.accountRequest.create({
    data: { userId, kind, status: "pending" },
    select: { id: true, kind: true, status: true, createdAt: true },
  });
}
