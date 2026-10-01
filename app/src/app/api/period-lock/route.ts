import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { getLockedThrough, setLockedThrough } from "@/lib/period-lock";
import { monthSchema } from "@/lib/validation";

const bodySchema = z.object({
  // null reopens the books.
  month: monthSchema.nullable(),
  // Lowering or clearing the lock must be asked for on purpose (F68).
  reopen: z.boolean().optional(),
  // The lock the user's screen showed; a different stored lock refuses the change (V48).
  expectedLockedThrough: monthSchema.nullable().optional(),
});

export const GET = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  return noStoreJson({ lockedThrough: await getLockedThrough(session.userId) });
});

export const PUT = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req);
  if (oversized) return oversized;

  const { month, reopen, expectedLockedThrough } = bodySchema.parse(await req.json());
  return noStoreJson(await setLockedThrough(session.userId, month, { reopen, expectedLockedThrough }));
});
