import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { importCustomers } from "@/lib/customers";

const bodySchema = z
  .object({
    csv: z.string().max(200_000),
    commit: z.boolean().optional(),
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
  return noStoreJson(await importCustomers(session.userId, body.csv, body.commit === true));
});
