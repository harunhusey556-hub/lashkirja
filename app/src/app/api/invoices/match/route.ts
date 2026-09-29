import { NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { matchInvoicePaymentsFromBank } from "@/lib/sales-invoices";

/** What a run would book, without booking anything: the confirmation preview. */
export const GET = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  return noStoreJson(await matchInvoicePaymentsFromBank(session.userId, new Date(), { dryRun: true }));
});

/** Runs reference-based reconciliation and returns what it did and suggests. */
export const POST = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req);
  if (oversized) return oversized;

  return noStoreJson(await matchInvoicePaymentsFromBank(session.userId));
});
