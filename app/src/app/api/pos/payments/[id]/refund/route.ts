import { z } from "zod";
import { ValidationError } from "@/lib/api-errors";
import { noStoreJson } from "@/lib/http-security";
import { hashIdempotencyPayload, idempotencyKeyFrom, withIdempotentSideEffect } from "@/lib/idempotency";
import { refundPosPayment } from "@/lib/pos-payments";
import { posRoute, type PosRouteContext } from "@/lib/pos-route";
import { moneySchema } from "@/lib/validation";

const bodySchema = z
  .object({
    amount: moneySchema.refine((value) => value > 0, "Summan pitää olla suurempi kuin nolla.").nullish(),
  })
  .strict();

/**
 * Refunds (part of) a card payment; the invoice payment shrinks or goes with it. An
 * Idempotency-Key is required: a retried refund answers the first one and is the same refund at
 * Stripe, so a lost answer can never turn into a second refund of real money.
 */
export const POST = posRoute({ write: true }, async (req, session, context: PosRouteContext) => {
  const { id } = await context.params;
  const key = idempotencyKeyFrom(req);
  if (!key) throw new ValidationError("Palautukselta puuttuu Idempotency-Key.");
  const raw = await req.text();
  const input = bodySchema.parse(raw.trim() ? JSON.parse(raw) : {});
  const result = await withIdempotentSideEffect(
    session.userId,
    "pos.refund",
    key,
    async () => ({ status: 200, body: await refundPosPayment(session.userId, id, input.amount, key) }),
    hashIdempotencyPayload({ id, amount: input.amount ?? null })
  );
  return noStoreJson(result.body, { status: result.status });
});
