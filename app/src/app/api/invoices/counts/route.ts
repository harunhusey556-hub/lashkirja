import { NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { noStoreJson } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { countInvoicesByDisplayStatus } from "@/lib/sales-invoices";
import { monthSchema } from "@/lib/validation";

/**
 * Per-status invoice counts for the sales list's filter chips. Separate from
 * `GET /api/invoices`, whose row list is capped at INVOICE_LIST_LIMIT - a
 * count over that capped list would silently drop older invoices from their
 * chip's count, so this counts the database directly instead.
 */
export const GET = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const params = req.nextUrl.searchParams;
  const rawMonth = params.get("month");
  const counts = await countInvoicesByDisplayStatus(session.userId, {
    customerId: params.get("customerId") ?? undefined,
    month: rawMonth ? monthSchema.parse(rawMonth) : undefined,
  });
  return noStoreJson({ counts });
});
