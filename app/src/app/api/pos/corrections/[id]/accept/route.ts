import type { NextRequest } from "next/server";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { guardWrite, noStoreJson } from "@/lib/http-security";
import { acceptRefundCorrection } from "@/lib/pos-payments";
import { requireSession } from "@/lib/session";

/**
 * Accepts a correction card of a card refund made after the payment's month
 * was locked: posts the negative card payment row in the first open month.
 * Bookkeeping only, so it works with Stripe switched off too. Repeating it
 * posts nothing more.
 */
export const POST = withErrorHandler(async (req: NextRequest, context: { params: Promise<{ id: string }> }) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  const { id } = await context.params;
  return noStoreJson({ invoice: await acceptRefundCorrection(session.userId, id) });
});
