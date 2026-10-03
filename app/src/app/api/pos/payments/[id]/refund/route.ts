import { z } from "zod";
import { noStoreJson } from "@/lib/http-security";
import { refundPosPayment } from "@/lib/pos-payments";
import { posRoute, type PosRouteContext } from "@/lib/pos-route";
import { moneySchema } from "@/lib/validation";

const bodySchema = z
  .object({
    amount: moneySchema.refine((value) => value > 0, "Summan pitää olla suurempi kuin nolla.").nullish(),
  })
  .strict();

/** Refunds (part of) a card payment; the invoice payment shrinks or goes with it. */
export const POST = posRoute({ write: true }, async (req, session, context: PosRouteContext) => {
  const { id } = await context.params;
  const raw = await req.text();
  const input = bodySchema.parse(raw.trim() ? JSON.parse(raw) : {});
  return noStoreJson(await refundPosPayment(session.userId, id, input.amount));
});
