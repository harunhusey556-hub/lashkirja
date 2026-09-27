import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { mergeCustomers } from "@/lib/customers";

const bodySchema = z
  .object({
    keepId: z.string().uuid(),
    mergeId: z.string().uuid(),
  })
  .strict();

export const POST = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req);
  if (oversized) return oversized;
  const body = bodySchema.parse(await req.json());
  const detail = await mergeCustomers(session.userId, body.keepId, body.mergeId);
  return noStoreJson(detail);
});
