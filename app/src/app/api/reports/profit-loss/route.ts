import { NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { revalidatedJson } from "@/lib/etag-json";
import { cachedForStamp, readBooksStamp } from "@/lib/books-cache";
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
  // W24: reused while nothing it reads has changed (lib/books-cache.ts), the same rule as Koti.
  const load = async () => {
    const sources = await loadAlvPeriodSources(session.userId, range.gte, range.lt);
    const report = buildProfitLoss(sources.reportReceipts, sources.reportInvoices);
    return {
      from: range.start,
      to: range.end,
      total: periodToEuros(report.total),
      months: report.months.map(periodToEuros),
      undatedCount: report.undatedCount,
      excludedReceiptCount: sources.excludedReceiptCount,
      suspectedDuplicateCount: sources.suspectedDuplicateCount,
      basis: "laskutusperuste",
    };
  };
  const stamp = await readBooksStamp(session.userId).catch((error: unknown) => {
    console.warn("Report cache stamp failed, computing uncached:", error);
    return null;
  });
  const body = stamp === null
    ? await load()
    : await cachedForStamp(`${session.userId}|profit-loss|${range.start}|${range.end}`, stamp, load);
  return revalidatedJson(req, body);
});
