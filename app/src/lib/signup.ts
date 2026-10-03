import bcrypt from "bcryptjs";
import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { guardWrite } from "@/lib/http-security";
import { platformMailConfig } from "@/lib/mailer";
import { clearCodeGuard, reserveCodeAttempt } from "@/lib/account-code-guard";
import {
  AccountSecurityError,
  MAX_CODE_ATTEMPTS,
  hashEmailCode,
  hashesEqual,
  newEmailCode,
} from "@/lib/account-security";

/**
 * Sign-up with an emailed 6-digit code. Nothing becomes a User until the code
 * is verified; until then the address, the bcrypt hash and the code hash wait
 * in PendingSignup.
 */
const SIGNUP_TTL_MS = 15 * 60 * 1000;
const SIGNUP_EXPIRED = "Vahvistuskoodi ei ole enää voimassa. Aloita tilin luonti uudelleen.";

export const SIGNUP_UNAVAILABLE = "Tilin luonti ei ole juuri nyt käytössä.";

export function signupEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SIGNUP_ENABLED?.trim().toLowerCase() === "true";
}

/** Feature flag, cross-site and size guard, and (when the route sends mail) platform mail. */
export function rejectSignupRequest(req: NextRequest, needsMail: boolean): NextResponse | null {
  if (!signupEnabled()) {
    return NextResponse.json(
      { error: "Uusien tilien luonti ei ole käytössä.", code: "SIGNUP_DISABLED" },
      { status: 403 }
    );
  }
  const blocked = guardWrite(req, 32 * 1024);
  if (blocked) return blocked;
  if (needsMail && !platformMailConfig()) {
    return NextResponse.json({ error: SIGNUP_UNAVAILABLE }, { status: 503 });
  }
  return null;
}

function codeScope(email: string): string {
  return `signup:${email}`;
}

export type SignupStart = { kind: "existing" } | { kind: "pending"; code: string };

/**
 * The password is hashed on both branches so an existing address takes as long
 * to answer as a new one.
 */
export async function startSignup(input: {
  email: string;
  password: string;
  firstName: string;
}): Promise<SignupStart> {
  const passwordHash = await bcrypt.hash(input.password, 12);
  const existing = await prisma.user.findUnique({ where: { email: input.email }, select: { id: true } });
  if (existing) return { kind: "existing" };
  const code = newEmailCode();
  const fields = {
    passwordHash,
    firstName: input.firstName,
    codeHash: hashEmailCode(codeScope(input.email), code),
    attempts: 0,
    expiresAt: new Date(Date.now() + SIGNUP_TTL_MS),
  };
  await prisma.pendingSignup.upsert({
    where: { email: input.email },
    create: { email: input.email, ...fields },
    update: fields,
  });
  return { kind: "pending", code };
}

/** Removes a pending sign-up whose code mail could not be sent. */
export async function discardPendingSignup(email: string) {
  await prisma.pendingSignup.deleteMany({ where: { email } });
}

/** A fresh code and a fresh 15 minutes for an existing pending sign-up; null when there is none. */
export async function renewSignupCode(email: string): Promise<string | null> {
  const code = newEmailCode();
  const renewed = await prisma.pendingSignup.updateMany({
    where: { email },
    data: {
      codeHash: hashEmailCode(codeScope(email), code),
      attempts: 0,
      expiresAt: new Date(Date.now() + SIGNUP_TTL_MS),
    },
  });
  return renewed.count === 1 ? code : null;
}

function expired() {
  return new AccountSecurityError(SIGNUP_EXPIRED, 410, "SIGNUP_EXPIRED");
}

function codeInvalid(attemptsLeft: number) {
  return new AccountSecurityError("Koodi ei kelpaa.", 400, "SIGNUP_CODE_INVALID", attemptsLeft);
}

/**
 * Checks the code and the password given at start, and creates the User in one
 * transaction with the pending row's removal. The password binds the code to
 * whoever started this sign-up: a later start by someone else replaces the
 * row, and then the first caller's password no longer matches it. A wrong
 * password is answered exactly like a wrong code.
 */
export async function verifySignup(email: string, code: string, password: string) {
  const row = await prisma.pendingSignup.findUnique({ where: { email } });
  if (!row || row.expiresAt.getTime() < Date.now()) throw expired();
  const scope = codeScope(email);
  const guard = await reserveCodeAttempt(scope);
  if (!guard.allowed) throw codeInvalid(0);
  // Counted before the compare, so parallel guesses cannot share one slot.
  const counted = await prisma.pendingSignup.updateMany({
    where: { id: row.id, attempts: { lt: MAX_CODE_ATTEMPTS } },
    data: { attempts: { increment: 1 } },
  });
  if (counted.count !== 1) {
    await prisma.pendingSignup.deleteMany({ where: { id: row.id } });
    throw expired();
  }
  // Both are checked every time, so the answer time does not tell which one failed.
  const codeMatches = hashesEqual(row.codeHash, hashEmailCode(scope, code));
  const passwordMatches = await bcrypt.compare(password, row.passwordHash);
  if (!codeMatches || !passwordMatches) {
    const after = await prisma.pendingSignup.findUnique({ where: { id: row.id } });
    const attemptsLeft = Math.max(0, MAX_CODE_ATTEMPTS - (after?.attempts ?? MAX_CODE_ATTEMPTS));
    if (attemptsLeft === 0) await prisma.pendingSignup.deleteMany({ where: { id: row.id } });
    throw codeInvalid(Math.min(attemptsLeft, guard.left));
  }
  try {
    const user = await prisma.$transaction(async (db) => {
      const consumed = await db.pendingSignup.deleteMany({ where: { id: row.id } });
      if (consumed.count !== 1) throw expired();
      return db.user.create({
        data: {
          email: row.email,
          passwordHash: row.passwordHash,
          firstName: row.firstName,
          lastName: "",
        },
        select: { id: true, email: true, firstName: true },
      });
    });
    await clearCodeGuard(scope);
    return user;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      // The address became a User after the code was sent; the pending row is spent either way.
      await prisma.pendingSignup.deleteMany({ where: { id: row.id } });
      throw new AccountSecurityError("Sähköposti on jo käytössä.", 409, "SIGNUP_EMAIL_TAKEN");
    }
    throw error;
  }
}

/** Cleanup run: an abandoned sign-up must not stay in the table forever. */
export async function pruneExpiredPendingSignups(now = new Date()) {
  const result = await prisma.pendingSignup.deleteMany({ where: { expiresAt: { lt: now } } });
  return result.count;
}

export function signupCodeMail(to: string, code: string) {
  return {
    to,
    subject: `LashKirja-vahvistuskoodi: ${code}`,
    text: `LashKirja-tilisi vahvistuskoodi on ${code}. Koodi on voimassa 15 minuuttia.\n\nJos et luonut LashKirja-tiliä, voit ohittaa tämän viestin.`,
  };
}

export function signupExistingMail(to: string, linkBase: string) {
  return {
    to,
    subject: "LashKirja-tilin luonti",
    text: `Joku yritti luoda LashKirja-tilin osoitteellasi. Jos se olit sinä, kirjaudu sisään tai palauta salasana: ${linkBase}/unohtunut-salasana`,
  };
}

export function welcomeMail(to: string, firstName: string, linkBase: string) {
  return {
    to,
    subject: "Tervetuloa LashKirjaan",
    text: `Hei ${firstName}, tervetuloa LashKirjaan! Tilisi on valmis. Kirjaudu sisään: ${linkBase}`,
  };
}
