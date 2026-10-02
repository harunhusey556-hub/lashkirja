import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { UnauthorizedError, ValidationError, withErrorHandler } from "@/lib/api-errors";
import { hashIdempotencyPayload, idempotencyKeyFrom, withIdempotency } from "@/lib/idempotency";
import { recordPurchasePayment, removePurchasePayment } from "@/lib/purchase-invoices";
import { isoDateSchema, moneySchema } from "@/lib/validation";

const bodySchema = z.object({
  amount: moneySchema,
  paidDate: isoDateSchema,
  transactionId: z.string().uuid().nullish(),
  note: z.string().trim().max(200).nullish(),
});

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req);
  if (oversized) return oversized;

  const { id } = await context.params;
  const input = bodySchema.parse(await req.json());
  // The app sends an Idempotency-Key: a retried "Merkitse maksetuksi" does not record the payment twice.
  const result = await withIdempotency(
    session.userId,
    "purchase-invoice.payment",
    idempotencyKeyFrom(req),
    async (tx) => ({
      status: 201,
      body: { invoice: await recordPurchasePayment(session.userId, id, input, tx ?? undefined) },
    }),
    hashIdempotencyPayload({ id, ...input })
  );
  return noStoreJson(result.body, { status: result.status });
});

export const DELETE = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;

  const { id } = await context.params;
  const paymentId = req.nextUrl.searchParams.get("paymentId");
  if (!paymentId) throw new ValidationError("Maksun tunnus puuttuu.");

  return noStoreJson({ invoice: await removePurchasePayment(session.userId, id, paymentId) });
});
