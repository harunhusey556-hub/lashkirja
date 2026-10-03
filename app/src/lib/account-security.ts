import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "crypto";
import bcrypt from "bcryptjs";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { clearCodeGuard, reserveCodeAttempt } from "@/lib/account-code-guard";
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

const DEVELOPMENT_SECRET = "lashkirja-local-development-only-secret-32-chars";

/**
 * Six digits are a million candidates: a plain hash of them is reversed at
 * once from a leaked database. The pepper lives only in SESSION_SECRET.
 */
function codePepper(): Buffer {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret && process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET must be configured in production");
  }
  return createHmac("sha256", secret || DEVELOPMENT_SECRET).update("lashkirja:email-code:v1").digest();
}

/** Scoped so one code hash cannot be replayed against another reset or sign-up. */
export function hashEmailCode(scope: string, code: string): string {
  return createHmac("sha256", codePepper()).update(`${scope}:${code.trim()}`).digest("hex");
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
  await prisma.$transaction((db) => revokeSessionsWithin(db, userId, new Date(), exceptId));
}

/** The writes of revokeAuthSessions, for a transaction that also changes the credential. */
async function revokeSessionsWithin(
  db: Prisma.TransactionClient,
  userId: string,
  now: Date,
  exceptId?: string
) {
  await db.authSession.updateMany({
    where: {
      userId,
      revokedAt: null,
      ...(exceptId ? { id: { not: exceptId } } : {}),
    },
    data: { revokedAt: now },
  });
  // Cookies that never received a session id cannot be found in AuthSession.
  // The cutoff is what makes those cookies fail requireSession.
  await db.user.update({
    where: { id: userId },
    data: { legacySessionsRevokedAt: now },
  });
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
      codeHash: hashEmailCode(resetScope(userId), code),
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
  await completeReset(row.id, row.userId, passwordHash, () => new AccountSecurityError("Linkki ei ole voimassa.", 400));
  await clearCodeGuard(resetScope(row.userId));
  return row.userId;
}

/**
 * Consume, new password and session revocation in one transaction: of two
 * parallel uses only the one whose conditional consume matched commits, and
 * no crash can leave a new password with the old sessions alive.
 */
async function completeReset(
  rowId: string,
  userId: string,
  passwordHash: string,
  spent: () => AccountSecurityError
) {
  await prisma.$transaction(async (db) => {
    const now = new Date();
    const consumed = await db.accountToken.updateMany({
      where: { id: rowId, purpose: "password_reset", usedAt: null, expiresAt: { gt: now } },
      data: { usedAt: now },
    });
    if (consumed.count !== 1) throw spent();
    await db.user.update({ where: { id: userId }, data: { passwordHash } });
    await revokeSessionsWithin(db, userId, now);
  });
}

function resetScope(userId: string): string {
  return `reset:${userId}`;
}

/**
 * One answer for a missing user, no active reset, an expired or blocked one
 * and a wrong code: anything else would tell which addresses have an account.
 */
function resetCodeInvalid() {
  return new AccountSecurityError("Koodi ei kelpaa tai se on vanhentunut.", 400, "RESET_CODE_INVALID");
}

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
  if (!row || !row.codeHash || row.expiresAt.getTime() < Date.now()) throw resetCodeInvalid();
  const scope = resetScope(row.userId);
  if (!(await reserveCodeAttempt(scope)).allowed) throw resetCodeInvalid();
  // The attempt is counted before the compare, so parallel guesses cannot
  // share one slot and the total stays at MAX_CODE_ATTEMPTS.
  const counted = await prisma.accountToken.updateMany({
    where: { id: row.id, usedAt: null, codeAttempts: { lt: MAX_CODE_ATTEMPTS } },
    data: { codeAttempts: { increment: 1 } },
  });
  if (counted.count !== 1) throw resetCodeInvalid();
  if (!hashesEqual(row.codeHash, hashEmailCode(scope, code))) {
    const after = await prisma.accountToken.findUniqueOrThrow({ where: { id: row.id } });
    if (after.codeAttempts >= MAX_CODE_ATTEMPTS) {
      await prisma.accountToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
    }
    throw resetCodeInvalid();
  }
  const passwordHash = await bcrypt.hash(nextPassword, 12);
  await completeReset(row.id, row.userId, passwordHash, resetCodeInvalid);
  await clearCodeGuard(scope);
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

const backgroundMail = new Set<Promise<void>>();

/**
 * Account mail work the response does not wait for: SMTP latency then
 * neither delays the answer nor tells which addresses have an account.
 * A failure is logged under `label` and never reaches the caller.
 */
export function deliverInBackground(label: string, task: () => Promise<void>): void {
  const running: Promise<void> = Promise.resolve()
    .then(task)
    .catch((error) => console.error(label, error))
    .finally(() => backgroundMail.delete(running));
  backgroundMail.add(running);
}

/** Tests: resolves once every background account mail task has finished. */
export async function settleAccountMailForTests(): Promise<void> {
  while (backgroundMail.size > 0) await Promise.allSettled([...backgroundMail]);
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

let missingOriginLogged = false;

/**
 * Public web origin for links in mail: APP_ORIGIN, else (outside production)
 * the request's own origin. In production a request-derived host could point
 * a reset link elsewhere, so without APP_ORIGIN the answer is null: send no
 * mail with a link.
 */
export function accountLinkBase(requestOrigin: string): string | null {
  const configured = process.env.APP_ORIGIN?.trim().replace(/\/$/, "");
  if (configured) return configured;
  if (process.env.NODE_ENV !== "production") return requestOrigin;
  if (!missingOriginLogged) {
    missingOriginLogged = true;
    console.error("APP_ORIGIN is not set: account mail with links is not sent");
  }
  return null;
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
 * Security notices are best-effort: the action has already committed, so the
 * whole notice, lookup included, runs after the answer and a failure is only
 * logged. sendAccountMail logs its own send failures; having no mail path at
 * all is not an error.
 */
function sendSecurityNotice(
  userId: string,
  compose: () => Promise<{ to: string; subject: string; text: string } | null>
): void {
  deliverInBackground(`Security notice failed (user ${userId})`, async () => {
    const mail = await compose();
    if (mail) await sendAccountMail(userId, mail);
  });
}

/** `linkBase` null (production without APP_ORIGIN): no notice, see accountLinkBase. */
export function notifyPasswordChanged(userId: string, linkBase: string | null, at = new Date()): void {
  sendSecurityNotice(userId, async () => {
    if (!linkBase) return null;
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
    if (!user) return null;
    return {
      to: user.email,
      subject: "LashKirjan salasana vaihdettiin",
      text: `LashKirjan salasana vaihdettiin ${helsinkiTime(at)}. Jos se et ollut sinä: ${linkBase}/unohtunut-salasana`,
    };
  });
}

export function notifyEmailChanged(userId: string, previousEmail: string, nextEmail: string): void {
  sendSecurityNotice(userId, async () => ({
    to: previousEmail,
    subject: "LashKirjan kirjautumissähköposti vaihdettiin",
    text: `Kirjautumissähköposti vaihdettiin osoitteeseen ${maskEmail(nextEmail)}. Jos se et ollut sinä, ${contactSupportPhrase()}.`,
  }));
}

export async function recordAccountRequest(userId: string, kind: "close" | "export", currentPassword: string) {
  await requireCurrentPassword(userId, currentPassword);
  return prisma.accountRequest.create({
    data: { userId, kind, status: "pending" },
    select: { id: true, kind: true, status: true, createdAt: true },
  });
}
