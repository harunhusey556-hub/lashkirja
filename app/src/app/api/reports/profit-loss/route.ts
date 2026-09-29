import { NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { noStoreJson } from "@/lib/http-security";
import { UnauthorizedError, ValidationError, withErrorHandler } from "@/lib/api-errors";
import { monthSchema } from "@/lib/validation";
import { buildProfitLoss, periodToEuros } from "@/lib/reports";
import { loadAlvPeriodSources } from "@/lib/alv-period";

/** Inclusive month range; defaults to the current calendar year. */
function resolveRange(from: string | null, to: string | null) {
  const now = new Date();
  const year = now.getUTCFullYear();
  const start = from ? monthSchema.parse(from) : `${year}-01`;
  const end = to ? monthSchema.parse(to) : `${year}-12`;
  if (start > end) throw new ValidationError("Alkukuukausi on loppukuukauden jälkeen.");

  const [startYear, startMonth] = start.split("-").map(Number);
  const [endYear, endMonth] = end.split("-").map(Number);
  return {
    start,
    end,
    gte: new Date(Date.UTC(startYear, startMonth - 1, 1)),
    lt: new Date(Date.UTC(endYear, endMonth, 1)),
  };
}

export const GET = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const params = req.nextUrl.searchParams;
  const range = resolveRange(params.get("from"), params.get("to"));

  // Same sources as the VAT return: approved receipts plus booked sales
  // invoices and credit notes, with bank-settled income receipts deduplicated.
  const sources = await loadAlvPeriodSources(session.userId, range.gte, range.lt);
  const report = buildProfitLoss(sources.reportReceipts, sources.reportInvoices);
  return noStoreJson({
    from: range.start,
    to: range.end,
    total: periodToEuros(report.total),
    months: report.months.map(periodToEuros),
    undatedCount: report.undatedCount,
    excludedReceiptCount: sources.excludedReceiptCount,
    basis: "laskutusperuste",
  });
});
