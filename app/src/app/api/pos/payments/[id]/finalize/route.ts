import { noStoreJson } from "@/lib/http-security";
import { finalizePosPayment } from "@/lib/pos-payments";
import { posRoute, type PosRouteContext } from "@/lib/pos-route";

/**
 * Asks Stripe for the PaymentIntent. Only "succeeded" books the invoice
 * payment (once); anything else answers 409 {error, status}.
 */
export const POST = posRoute({ write: true }, async (_req, session, context: PosRouteContext) => {
  const { id } = await context.params;
  return noStoreJson(await finalizePosPayment(session.userId, id));
});
