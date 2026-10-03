import type { NextRequest } from "next/server";
import { requireSession, type AuthenticatedSession } from "./session";
import { guardWrite, noStoreJson } from "./http-security";
import { UnauthorizedError, withErrorHandler } from "./api-errors";
import { POS_DISABLED_MESSAGE, StripeDisabledError, stripeConfigured } from "./stripe";
import { PosPaymentNotSucceededError } from "./pos-payments";

/**
 * The shared shell of every /api/pos/* route: the feature switch (503 with a
 * flat Finnish {error} when the server has no Stripe key), the session, the
 * cross-site and body-size guard on writes, and the 409 {error, status} answer
 * of a card payment Stripe has not confirmed as succeeded.
 */
export function posRoute<Args extends unknown[]>(
  options: { write: boolean },
  handler: (req: NextRequest, session: AuthenticatedSession, ...args: Args) => Promise<Response>
) {
  return withErrorHandler(async (req: NextRequest, ...args: Args): Promise<Response> => {
    if (!stripeConfigured()) return noStoreJson({ error: POS_DISABLED_MESSAGE }, { status: 503 });
    const session = await requireSession(req);
    if (!session) throw new UnauthorizedError();
    if (options.write) {
      const blocked = guardWrite(req);
      if (blocked) return blocked;
    }
    try {
      return await handler(req, session, ...args);
    } catch (error) {
      if (error instanceof PosPaymentNotSucceededError) {
        return noStoreJson(
          { error: error.message, code: error.code, status: error.paymentStatus },
          { status: 409 }
        );
      }
      if (error instanceof StripeDisabledError) {
        return noStoreJson({ error: POS_DISABLED_MESSAGE }, { status: 503 });
      }
      throw error;
    }
  });
}

export type PosRouteContext = { params: Promise<{ id: string }> };
