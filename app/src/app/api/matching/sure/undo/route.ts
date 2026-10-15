import { NextRequest } from "next/server";
import { z } from "zod";
import { guardWrite, noStoreJson } from "@/lib/http-security";
import { requireSession } from "@/lib/session";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { undoSureMatchBatch } from "@/lib/sure-matches";

const bodySchema = z.object({ batchId: z.string().min(1).max(64) }).strict();

/** "Kumoa" after "Kohdista varmat": the whole batch goes back to suggestions. */
export const POST = withErrorHandler(async (req: NextRequest) => {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  const { batchId } = bodySchema.parse(await req.json().catch(() => null));
  return noStoreJson(await undoSureMatchBatch(session.userId, batchId));
});
