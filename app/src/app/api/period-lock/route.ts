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

  const { month } = bodySchema.parse(await req.json());
  return noStoreJson(await setLockedThrough(session.userId, month));
});
