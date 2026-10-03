import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { AppError, UnauthorizedError, ValidationError, withErrorHandler } from "@/lib/api-errors";
import { hashIdempotencyPayload, idempotencyKeyFrom, withIdempotency } from "@/lib/idempotency";
import { CARD_PAYMENT_NOT_REMOVABLE, recordPayment, removePayment } from "@/lib/sales-invoices";
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
  const result = await withIdempotency(
    session.userId,
    `invoice.payment:${id}`,
    idempotencyKeyFrom(req),
    async (tx) => ({
      status: 201,
      body: { invoice: await recordPayment(session.userId, id, input, tx ?? undefined) },
    }),
    hashIdempotencyPayload(input)
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

  try {
    return noStoreJson({ invoice: await removePayment(session.userId, id, paymentId) });
  } catch (error) {
    // A card payment is undone by a refund, never deleted. Flat {error} as the
    // POS contract defines it.
    if (error instanceof AppError && error.code === CARD_PAYMENT_NOT_REMOVABLE) {
      return noStoreJson({ error: error.message, code: error.code }, { status: 409 });
    }
    throw error;
  }
});
