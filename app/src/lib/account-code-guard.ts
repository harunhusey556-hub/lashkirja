import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

/**
 * Durable budget of emailed-code guesses per target ("signup:<email>",
 * "reset:<userId>"). It lives apart from the code rows, so a new code never
 * buys new guesses, and in the database, so a restart does not either.
 */
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const HOUR_LIMIT = 5;
const DAY_LIMIT = 10;

export type CodeAttempt = { allowed: false } | { allowed: true; left: number };

/**
 * Counts one guess before the compare, so parallel guesses cannot share a
 * slot. A caller that gets `allowed: false` answers like a wrong code without
 * comparing; `left` is how many more guesses fit before the block.
 */
export async function reserveCodeAttempt(scope: string, now = new Date()): Promise<CodeAttempt> {
  try {
    await prisma.accountCodeGuard.upsert({
      where: { scope },
      create: { scope, hourStart: now, dayStart: now },
      update: {},
    });
  } catch (error) {
    // A parallel guess created the row first; the counting below still holds.
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) throw error;
  }
  await prisma.accountCodeGuard.updateMany({
    where: { scope, hourStart: { lte: new Date(now.getTime() - HOUR_MS) } },
    data: { hourFailures: 0, hourStart: now },
  });
  await prisma.accountCodeGuard.updateMany({
    where: { scope, dayStart: { lte: new Date(now.getTime() - DAY_MS) } },
    data: { dayFailures: 0, dayStart: now },
  });
  const counted = await prisma.accountCodeGuard.updateMany({
    where: {
      scope,
      hourFailures: { lt: HOUR_LIMIT },
      dayFailures: { lt: DAY_LIMIT },
      OR: [{ blockedUntil: null }, { blockedUntil: { lte: now } }],
    },
    data: { hourFailures: { increment: 1 }, dayFailures: { increment: 1 } },
  });
  if (counted.count !== 1) return { allowed: false };
  const row = await prisma.accountCodeGuard.findUniqueOrThrow({ where: { scope } });
  const blockFor =
    row.dayFailures >= DAY_LIMIT ? DAY_MS : row.hourFailures >= HOUR_LIMIT ? HOUR_MS : 0;
  if (blockFor > 0) {
    // Set when the last allowed guess is reserved; a correct guess clears it.
    await prisma.accountCodeGuard.update({
      where: { scope },
      data: { blockedUntil: new Date(now.getTime() + blockFor) },
    });
  }
  return { allowed: true, left: Math.min(HOUR_LIMIT - row.hourFailures, DAY_LIMIT - row.dayFailures) };
}

/** A correct code clears the target's budget. */
export async function clearCodeGuard(scope: string) {
  await prisma.accountCodeGuard.deleteMany({ where: { scope } });
}

/** Cleanup run: rows whose windows and block have all run out count nothing any more. */
export async function pruneStaleCodeGuards(now = new Date()) {
  const result = await prisma.accountCodeGuard.deleteMany({
    where: {
      dayStart: { lte: new Date(now.getTime() - DAY_MS) },
      OR: [{ blockedUntil: null }, { blockedUntil: { lte: now } }],
    },
  });
  return result.count;
}
