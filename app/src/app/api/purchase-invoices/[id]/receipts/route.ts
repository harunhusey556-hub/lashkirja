import { NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { noStoreJson } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { listReceiptCandidatesForPurchase } from "@/lib/purchase-invoices";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * The receipt linked to a purchase invoice and the receipts that could be the
 * same purchase (M1-2). Linking is a PATCH of the invoice with `receiptId`.
 */
export const GET = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  const { id } = await context.params;
  return noStoreJson(await listReceiptCandidatesForPurchase(session.userId, id));
});
