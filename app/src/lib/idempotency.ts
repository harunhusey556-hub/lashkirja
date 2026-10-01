import { createHash } from "crypto";
import type { NextRequest } from "next/server";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "./db";
import { ConflictError } from "./api-errors";

const KEY_MAX = 80;
/** A crashed request leaves statusCode 0. After this, the key can be claimed again. */
export const IDEMPOTENCY_PROCESSING_MS = 2 * 60 * 1000;

export function idempotencyKeyFrom(req: NextRequest): string | null {
  const key = req.headers.get("idempotency-key")?.trim() ?? "";
  if (!key || key.length > KEY_MAX) return null;
  return key;
}

/** Stable hash of the JSON body the route already parsed. */
export function hashIdempotencyPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export interface IdempotentResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

type IdempotencyRow = {
  id: string;
  statusCode: number;
  body: string;
  requestHash: string;
  createdAt: Date;
};

let failResponseSaves = 0;

/** Test hook: the next completed run rolls the business write back with the response row. */
export function failNextIdempotencyResponseForTests(times = 1): void {
  failResponseSaves = times;
}

function isUniqueConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

function isStaleProcessing(row: IdempotencyRow, now = Date.now()): boolean {
  return row.statusCode === 0 && now - row.createdAt.getTime() > IDEMPOTENCY_PROCESSING_MS;
}

function assertSamePayload(row: IdempotencyRow, requestHash: string | null): void {
  if (!row.requestHash || !requestHash || row.requestHash === requestHash) return;
  throw new ConflictError(
    "Sama pyyntötunniste on jo käytetty eri sisällöllä.",
    "IDEMPOTENCY_PAYLOAD_MISMATCH"
  );
}

/**
 * The first request with a key runs `run` and stores the response in the same
 * database transaction as the business write. If storing the response fails,
 * the business write rolls back with it, so a retry cannot insert a second row.
 * A request that arrives while the first is still running is refused.
 * The same key with a different body is refused.
 */
export async function withIdempotency<T>(
  userId: string,
  scope: string,
  key: string | null,
  run: (tx: Prisma.TransactionClient | null) => Promise<{ status: number; body: T }>,
  requestHash: string | null = null
): Promise<IdempotentResult<T>> {
  // No key: the caller opens its own short transaction. Wrapping that work
  // here deadlocks SQLite, because the inner reads use another connection
  // while this one is still open.
  if (!key) {
    const fresh = await run(null);
    return { ...fresh, replayed: false };
  }

  const answered = await claimKey<T>(userId, scope, key, requestHash);
  if (answered) return answered;

  const maxAttempts = 5;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const result = await prisma.$transaction(async (tx) => {
        const produced = await run(tx);
        if (failResponseSaves > 0) {
          failResponseSaves -= 1;
          throw new Error("idempotency response was not stored");
        }
        await tx.idempotencyRecord.update({
          where: { userId_scope_key: { userId, scope, key } },
          data: { statusCode: produced.status, body: JSON.stringify(produced.body) },
        });
        return produced;
      });
      return { ...result, replayed: false };
    } catch (error) {
      lastError = error;
      if (isUniqueConflict(error) && attempt < maxAttempts - 1) continue;
      await prisma.idempotencyRecord.deleteMany({
        where: { userId, scope, key, statusCode: 0 },
      });
      throw error;
    }
  }
  throw lastError;
}

/**
 * Claims the key for this request (a row with statusCode 0), or returns the
 * answer an earlier request with the same key already stored. Null means the
 * key is now this request's to use.
 */
async function claimKey<T>(
  userId: string,
  scope: string,
  key: string,
  requestHash: string | null
): Promise<IdempotentResult<T> | null> {
  const existing = await prisma.idempotencyRecord.findUnique({
    where: { userId_scope_key: { userId, scope, key } },
  });
  if (existing) {
    if (isStaleProcessing(existing)) {
      const removed = await prisma.idempotencyRecord.deleteMany({
        where: { id: existing.id, statusCode: 0 },
      });
      if (removed.count === 0) {
        const raced = await prisma.idempotencyRecord.findUnique({
          where: { userId_scope_key: { userId, scope, key } },
        });
        if (raced) return replay(raced, requestHash);
      }
    } else {
      return replay(existing, requestHash);
    }
  }

  try {
    await prisma.idempotencyRecord.create({
      data: { userId, scope, key, statusCode: 0, body: "", requestHash: requestHash ?? "" },
    });
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    const raced = await prisma.idempotencyRecord.findUnique({
      where: { userId_scope_key: { userId, scope, key } },
    });
    if (raced) return replay(raced, requestHash);
    throw error;
  }
  return null;
}

/**
 * Like withIdempotency, for work that must not sit inside a database
 * transaction: a mail leaving the server cannot be rolled back, and the PDF
 * render and SMTP take longer than an interactive transaction may. The key is
 * claimed first, the work runs on its own, and the answer is stored after. A
 * retry with the same key gets that answer instead of doing the work again; if
 * the work failed the key is released, so the retry runs it.
 */
export async function withIdempotentSideEffect<T>(
  userId: string,
  scope: string,
  key: string | null,
  run: () => Promise<{ status: number; body: T }>,
  requestHash: string | null = null
): Promise<IdempotentResult<T>> {
  if (!key) {
    const fresh = await run();
    return { ...fresh, replayed: false };
  }
  const answered = await claimKey<T>(userId, scope, key, requestHash);
  if (answered) return answered;

  let produced: { status: number; body: T };
  try {
    produced = await run();
  } catch (error) {
    await prisma.idempotencyRecord.deleteMany({ where: { userId, scope, key, statusCode: 0 } });
    throw error;
  }
  // The work is done and cannot be undone: a failure to store the answer must
  // not turn into a failure of the request.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await prisma.idempotencyRecord.update({
        where: { userId_scope_key: { userId, scope, key } },
        data: { statusCode: produced.status, body: JSON.stringify(produced.body) },
      });
      break;
    } catch (error) {
      if (attempt === 2) console.error("Idempotent send answer was not stored", error);
    }
  }
  return { ...produced, replayed: false };
}

function replay<T>(row: IdempotencyRow, requestHash: string | null): IdempotentResult<T> {
  assertSamePayload(row, requestHash);
  if (row.statusCode === 0) {
    throw new ConflictError("Sama pyyntö on jo käynnissä. Odota hetki ja yritä uudelleen.");
  }
  return { status: row.statusCode, body: JSON.parse(row.body) as T, replayed: true };
}
