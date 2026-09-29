import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import {
  dismissPaymentDuplicate,
  getInvoice,
  linkPaymentToTransaction,
} from "@/lib/sales-invoices";

const bodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("link"),
    paymentId: z.string().uuid(),
    transactionId: z.string().uuid(),
  }),
  z.object({
    action: z.literal("dismiss"),
    paymentId: z.string().uuid(),
    receiptId: z.string().uuid(),
  }),
]);

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Settles a flagged "same money twice" pair: `link` attaches the bank row to
 * the hand-recorded payment (the receipt from that row then stops counting),
 * `dismiss` records that the two are separate incomes.
 */
export const POST = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req);
  if (oversized) return oversized;

  const { id } = await context.params;
  const input = bodySchema.parse(await req.json());
  if (input.action === "link") {
    return noStoreJson({
      invoice: await linkPaymentToTransaction(session.userId, id, input.paymentId, input.transactionId),
    });
  }
  await dismissPaymentDuplicate(session.userId, id, input.paymentId, input.receiptId);
  return noStoreJson({ invoice: await getInvoice(session.userId, id) });
});
