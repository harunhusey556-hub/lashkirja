import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { computeAlvReport } from "@/lib/alv";
import { loadAlvPeriodSources } from "@/lib/alv-period";
import { OMAVERO_FIELDS } from "@/lib/vero/omavero-fields";
import { noStoreJson } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { alvPeriodBoundsUtc, alvPeriodSchema, helsinkiMonthKey } from "@/lib/validation";

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

  const [user, sources] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { vatRegistered: true } }),
    loadAlvPeriodSources(userId, start, end),
  ]);

  const report = computeAlvReport(sources.receipts, sources.invoices);

  return noStoreJson({
    period: { key: period, start: start.toISOString(), end: end.toISOString() },
    vatRegistered: user?.vatRegistered ?? false,
    field301: { label: OMAVERO_FIELDS[301], ...report.field301 },
    field302: { label: OMAVERO_FIELDS[302], ...report.field302 },
    field303: { label: OMAVERO_FIELDS[303], ...report.field303 },
    field309: { label: OMAVERO_FIELDS[309], ...report.field309 },
    field307: { label: OMAVERO_FIELDS[307], ...report.field307 },
    field308: { label: OMAVERO_FIELDS[308], ...report.field308 },
    review: report.review,
    receiptCount: sources.receiptCount,
    sources: report.sources,
    excludedReceiptCount: sources.excludedReceiptCount,
    creditedInvoiceCount: sources.creditedInvoiceCount,
  });
});
