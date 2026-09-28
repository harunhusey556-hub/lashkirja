import { NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { noStoreJson } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { countPurchaseInvoicesByDisplayStatus } from "@/lib/purchase-invoices";

/**
 * Per-status payable counts for the purchase-invoice list's filter chips.
 * Separate from `GET /api/purchase-invoices`, whose row list is capped -
 * see `countPurchaseInvoicesByDisplayStatus`.
 */
export const GET = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const counts = await countPurchaseInvoicesByDisplayStatus(session.userId);
  return noStoreJson({ counts });
});
