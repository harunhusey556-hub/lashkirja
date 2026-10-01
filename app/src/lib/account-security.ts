import { createHash, randomBytes, timingSafeEqual } from "crypto";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { findSenderAccount, platformMailConfig, sendMail, sendPlatformMail } from "@/lib/mailer";
import { passwordProblem, deviceLabel } from "@/lib/session-policy";

const RESET_TTL_MS = 30 * 60 * 1000;
const EMAIL_TTL_MS = 24 * 60 * 60 * 1000;

export class AccountSecurityError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "AccountSecurityError";
    this.status = status;
  }
}

export function newAccountToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashAccountToken(token) };
}

export function hashAccountToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hashesEqual(left: string, right: string): boolean {
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

export async function revokeAuthSessions(userId: string, exceptId?: string) {
  const now = new Date();
  await prisma.$transaction(revokeSessionWrites(userId, now, exceptId));
}

/**
 * The "lock everyone else out" path: password reset, password change and
 * signing out other/all devices. Revokes the sessions AND deletes every
 * passkey, because a passkey is a login that outlives sessions: one added
 * through a stolen session would otherwise survive the very action the owner
 * takes to get rid of the intruder. The owner adds their own again afterwards.
 * Returns how many passkeys were removed, so the UI can say so.
 */
export async function revokeAccess(userId: string, exceptSessionId?: string): Promise<{ passkeysRemoved: number }> {
  const now = new Date();
  const [removed] = await prisma.$transaction([
    prisma.passkeyCredential.deleteMany({ where: { userId } }),
    ...revokeSessionWrites(userId, now, exceptSessionId),
  ]);
  return { passkeysRemoved: removed.count };
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
  return revokeAccess(userId, currentSessionId);
}

async function retireTokens(userId: string, purpose: string) {
  await prisma.accountToken.updateMany({
    where: { userId, purpose, usedAt: null },
    data: { usedAt: new Date() },
  });
}

export async function issuePasswordReset(userId: string) {
  await retireTokens(userId, "password_reset");
  const minted = newAccountToken();
  await prisma.accountToken.create({
    data: {
      userId,
      purpose: "password_reset",
      tokenHash: minted.tokenHash,
      expiresAt: new Date(Date.now() + RESET_TTL_MS),
    },
  });
  return minted.token;
}

export async function resetPasswordWithToken(token: string, nextPassword: string) {
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
  return revokeAccess(row.userId);
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
  await prisma.$transaction([
    prisma.user.update({
      where: { id: row.userId },
      data: { email: row.payload, pendingEmail: null },
    }),
    prisma.accountToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
  ]);
  return { userId: row.userId, email: row.payload };
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

export async function recordAccountRequest(userId: string, kind: "close" | "export", currentPassword: string) {
  await requireCurrentPassword(userId, currentPassword);
  return prisma.accountRequest.create({
    data: { userId, kind, status: "pending" },
    select: { id: true, kind: true, status: true, createdAt: true },
  });
}
