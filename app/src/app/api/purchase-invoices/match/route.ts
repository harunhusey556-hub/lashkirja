import { NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { matchPurchasePaymentsFromBank } from "@/lib/purchase-invoices";

/** Reference-based reconciliation of outgoing bank rows against payables. */
export const POST = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req);
  if (oversized) return oversized;

  return noStoreJson(await matchPurchasePaymentsFromBank(session.userId));
});
