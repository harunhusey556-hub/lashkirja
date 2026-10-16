import { NextRequest } from "next/server";
import { guardWrite, noStoreJson } from "@/lib/http-security";
import { requireSession } from "@/lib/session";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { idempotencyKeyFrom, withIdempotentSideEffect } from "@/lib/idempotency";
import { linkSureMatches, listSureMatches } from "@/lib/sure-matches";

/** The sure pairs "Kohdista varmat (N)" would link now; nothing is written. */
export const GET = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  const pairs = await listSureMatches(session.userId);
  return noStoreJson({ count: pairs.length, pairs });
});

/**
 * Links every sure pair (a chunk of pairs per transaction) and answers which
 * ones, with the batch id that "Kumoa" takes back. The chunks commit on their
 * own, so the key is held outside them: the same Idempotency-Key replays the
 * answer, and any repeat simply finds nothing left to link.
 */
export const POST = withErrorHandler(async (req: NextRequest) => {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  const result = await withIdempotentSideEffect(session.userId, "matching.sure", idempotencyKeyFrom(req), async () => ({
    status: 200,
    body: await linkSureMatches(session.userId),
  }));
  return noStoreJson(result.body, { status: result.status });
});
