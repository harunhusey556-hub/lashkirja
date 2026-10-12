import { NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { noStoreJson } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { receiptPurchaseInvoiceView } from "@/lib/purchase-invoices";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * The ostolasku this receipt is filed as, if any, and what the reading called
 * the document: the receipt screen's "Tämä on ostolasku" notice. Changing the
 * kind is PATCH /api/receipts/[id] with `documentType`.
 */
export const GET = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  const { id } = await context.params;
  return noStoreJson(await receiptPurchaseInvoiceView(session.userId!, id));
});
