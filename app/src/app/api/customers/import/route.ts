import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { importCustomers } from "@/lib/customers";
import { hashIdempotencyPayload, idempotencyKeyFrom, withIdempotency } from "@/lib/idempotency";

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
  if (body.commit !== true) return noStoreJson(await importCustomers(session.userId, body.csv, false));
  // A retried commit (lost answer, double tap) with the same Idempotency-Key gets the first
  // answer back instead of creating every customer a second time. The rows and the stored
  // answer commit in one transaction, so a failed save leaves nothing half imported.
  const result = await withIdempotency(
    session.userId,
    "customer.import",
    idempotencyKeyFrom(req),
    async (tx) => ({
      status: 200,
      body: await importCustomers(session.userId, body.csv, true, tx ?? undefined),
    }),
    hashIdempotencyPayload(body)
  );
  return noStoreJson(result.body, { status: result.status });
});
