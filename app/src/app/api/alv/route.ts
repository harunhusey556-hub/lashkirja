import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { alvReportOf, loadAlvPeriodSources } from "@/lib/alv-period";
import { OMAVERO_FIELDS } from "@/lib/vero/omavero-fields";
import { noStoreJson } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { alvPeriodBoundsUtc, alvPeriodSchema, helsinkiMonthKey } from "@/lib/validation";
import { countPendingReceipts, getVatFiling } from "@/lib/vat-filing";

export const GET = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  const userId = session.userId;

  const now = new Date();
  const raw = req.nextUrl.searchParams.get("period");
  const period = raw
    ? alvPeriodSchema.parse(raw)
    : helsinkiMonthKey(now);
  // UTC bounds: receipt dates are stored as UTC midnight, so building the
  // window in server-local time would move rows across period boundaries.
  const { start, end } = alvPeriodBoundsUtc(period);

  const [user, sources, filing, pendingReceiptCount] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { vatRegistered: true } }),
    loadAlvPeriodSources(userId, start, end),
    getVatFiling(userId, period),
    countPendingReceipts(userId, start, end),
  ]);

  const report = alvReportOf(sources);

  return noStoreJson({
    period: { key: period, start: start.toISOString(), end: end.toISOString() },
    vatRegistered: user?.vatRegistered ?? false,
    field301: { label: OMAVERO_FIELDS[301], ...report.field301 },
    field302: { label: OMAVERO_FIELDS[302], ...report.field302 },
    field303: { label: OMAVERO_FIELDS[303], ...report.field303 },
    field309: { label: OMAVERO_FIELDS[309], ...report.field309 },
    // Reverse charge (foreign purchases): the tax here is deducted again in 307.
    field305: { label: OMAVERO_FIELDS[305], ...report.field305 },
    field306: { label: OMAVERO_FIELDS[306], ...report.field306 },
    field313: { label: OMAVERO_FIELDS[313], ...report.field313 },
    field314: { label: OMAVERO_FIELDS[314], ...report.field314 },
    field307: { label: OMAVERO_FIELDS[307], ...report.field307 },
    field308: { label: OMAVERO_FIELDS[308], ...report.field308 },
    review: report.review,
    receiptCount: sources.receiptCount,
    sources: report.sources,
    excludedReceiptCount: sources.excludedReceiptCount,
    suspectedDuplicateCount: sources.suspectedDuplicateCount,
    // F39: purchase invoices count as deductible VAT; these say what was left out or may be counted twice.
    skippedPurchaseInvoiceCount: sources.skippedPurchaseInvoiceCount,
    suspectedPurchaseDuplicateCount: sources.suspectedPurchaseDuplicateCount,
    purchaseReceiptUnusableCount: sources.purchaseReceiptUnusableCount,
    creditedInvoiceCount: sources.creditedInvoiceCount,
    creditNoteCount: sources.creditNoteCount,
    // FP-13 / TF-11: the filed and paid state, and what is not in the figure yet.
    filing,
    pendingReceiptCount,
    basis: "laskutusperuste",
  });
});
