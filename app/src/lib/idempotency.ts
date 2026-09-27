import type { NextRequest } from "next/server";
import { prisma } from "./db";
import { ConflictError } from "./api-errors";

const KEY_MAX = 80;

export function idempotencyKeyFrom(req: NextRequest): string | null {
  const key = req.headers.get("idempotency-key")?.trim() ?? "";
  if (!key || key.length > KEY_MAX) return null;
  return key;
}

export interface IdempotentResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

function isUniqueConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

/**
 * The first request with a key runs `run` and stores the response.
 * A second request with the same key returns that response and does not run again.
 * A request that arrives while the first is still running is refused.
 */
export async function withIdempotency<T>(
  userId: string,
  scope: string,
  key: string | null,
  run: () => Promise<{ status: number; body: T }>
): Promise<IdempotentResult<T>> {
  if (!key) {
    const fresh = await run();
    return { ...fresh, replayed: false };
  }

  const existing = await prisma.idempotencyRecord.findUnique({
    where: { userId_scope_key: { userId, scope, key } },
  });
  if (existing) return replay(existing);

  try {
    await prisma.idempotencyRecord.create({
      data: { userId, scope, key, statusCode: 0, body: "" },
    });
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    const raced = await prisma.idempotencyRecord.findUnique({
      where: { userId_scope_key: { userId, scope, key } },
    });
    if (raced) return replay(raced);
    throw error;
  }

  try {
    const result = await run();
    await prisma.idempotencyRecord.update({
      where: { userId_scope_key: { userId, scope, key } },
      data: { statusCode: result.status, body: JSON.stringify(result.body) },
    });
    return { ...result, replayed: false };
  } catch (error) {
    await prisma.idempotencyRecord.deleteMany({ where: { userId, scope, key, statusCode: 0 } });
    throw error;
  }
}

function replay<T>(row: { statusCode: number; body: string }): IdempotentResult<T> {
  if (row.statusCode === 0) {
    throw new ConflictError("Sama pyyntö on jo käynnissä. Odota hetki ja yritä uudelleen.");
  }
  return { status: row.statusCode, body: JSON.parse(row.body) as T, replayed: true };
}
