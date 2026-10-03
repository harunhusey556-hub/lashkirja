import { z } from "zod";
import { noStoreJson } from "@/lib/http-security";
import { hashIdempotencyPayload, idempotencyKeyFrom, withIdempotentSideEffect } from "@/lib/idempotency";
import { createPosPaymentIntent } from "@/lib/pos-payments";
import { posRoute } from "@/lib/pos-route";
import { moneySchema } from "@/lib/validation";

const bodySchema = z
  .object({
    invoiceId: z.string().uuid(),
    amount: moneySchema.refine((value) => value > 0, "Summan pitää olla suurempi kuin nolla."),
  })
  .strict();

/**
 * Starts a card payment for an invoice. The Idempotency-Key makes a retried
 * tap answer the same payment (and the same PaymentIntent at Stripe). The
 * Stripe call cannot sit inside a database transaction, so the side-effect
 * variant of withIdempotency claims the key first and stores the answer after.
 */
export const POST = posRoute({ write: true }, async (req, session) => {
  const input = bodySchema.parse(await req.json());
  const key = idempotencyKeyFrom(req);
  const result = await withIdempotentSideEffect(
    session.userId,
    "pos.payment-intent",
    key,
    async () => ({
      status: 201,
      body: { payment: await createPosPaymentIntent(session.userId, input, key) },
    }),
    hashIdempotencyPayload(input)
  );
  return noStoreJson(result.body, { status: result.status });
});
