import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { hashIdempotencyPayload, idempotencyKeyFrom, withIdempotency } from "@/lib/idempotency";
import { eurosToCents } from "@/lib/money";
import { createPurchaseCreditNote } from "@/lib/purchase-invoices";
import { isoDateSchema, nonnegativeMoneySchema } from "@/lib/validation";

// `amount` is optional: leaving it out credits everything still creditable.
const bodySchema = z
  .object({
    amount: nonnegativeMoneySchema.optional(),
    /** VAT inside the credit; omitted = the invoice's VAT pro rata. */
    vat: nonnegativeMoneySchema.optional(),
    date: isoDateSchema,
    reason: z.string().trim().min(3, "Kirjoita hyvityksen syy").max(300),
    supplierNumber: z.string().trim().max(40).nullish(),
  })
  .strict();

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
  // A retried tap with the same Idempotency-Key returns the first credit note
  // instead of a second one; the over-credit check stops a different key.
  const result = await withIdempotency(
    session.userId,
    "purchase-invoice.credit",
    idempotencyKeyFrom(req),
    async (tx) => ({
      status: 201,
      body: await createPurchaseCreditNote(
        session.userId,
        id,
        {
          amountCents: input.amount === undefined ? undefined : eurosToCents(input.amount),
          vatCents: input.vat === undefined ? undefined : eurosToCents(input.vat),
          reason: input.reason,
          date: input.date,
          supplierNumber: input.supplierNumber,
        },
        tx ?? undefined
      ),
    }),
    hashIdempotencyPayload({ id, ...input })
  );
  return noStoreJson(result.body, { status: result.status });
});
