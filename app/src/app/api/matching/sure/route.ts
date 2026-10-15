import { NextRequest } from "next/server";
import { guardWrite, noStoreJson } from "@/lib/http-security";
import { requireSession } from "@/lib/session";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { idempotencyKeyFrom, withIdempotency } from "@/lib/idempotency";
import { linkSureMatches, listSureMatches } from "@/lib/sure-matches";

/** The sure pairs "Kohdista varmat (N)" would link now; nothing is written. */
export const GET = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  const pairs = await listSureMatches(session.userId);
  return noStoreJson({ count: pairs.length, pairs });
});

/**
 * Links every sure pair in one transaction and answers which ones, with the
 * batch id that "Kumoa" takes back. The same Idempotency-Key replays the answer;
 * without one a repeat simply finds nothing left to link.
 */
export const POST = withErrorHandler(async (req: NextRequest) => {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  const result = await withIdempotency(session.userId, "matching.sure", idempotencyKeyFrom(req), async (tx) => ({
    status: 200,
    body: await linkSureMatches(session.userId, tx),
  }));
  return noStoreJson(result.body, { status: result.status });
});
