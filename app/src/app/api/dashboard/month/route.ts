import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { noStoreJson } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { helsinkiMonthKey, monthBoundsUtc, monthSchema } from "@/lib/validation";
import { getLockedThrough, isMonthLocked } from "@/lib/period-lock";
import { MONTH_ROW_FACTS, monthProgress } from "@/lib/month-rows";
import { buildDashboardItems } from "../items";

/** Everything left in one month, uncapped: the month close checklist (FP-13, TF-07). */
const CHECKLIST_LIMIT = 200;

export const GET = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  const month = monthSchema.parse(req.nextUrl.searchParams.get("month"));
  const now = new Date();
  const currentMonth = helsinkiMonthKey(now);

  const [items, lockedThrough, rows, user] = await Promise.all([
    buildDashboardItems(session.userId, month, false, now, undefined, CHECKLIST_LIMIT),
    getLockedThrough(session.userId),
    prisma.transaction.findMany({
      where: { statement: { userId: session.userId, periodMonth: month } },
      select: MONTH_ROW_FACTS,
    }),
    prisma.user.findUnique({
      where: { id: session.userId },
      select: { vatRegistered: true, vatPeriod: true },
    }),
  ]);
  const { start, end } = monthBoundsUtc(month);
  const [statements, receiptCount, invoiceCount] = await Promise.all([
    prisma.statement.count({ where: { userId: session.userId, periodMonth: month } }),
    prisma.receipt.count({ where: { userId: session.userId, date: { gte: start, lt: end } } }),
    prisma.salesInvoice.count({ where: { userId: session.userId, issueDate: { gte: start, lt: end } } }),
  ]);

  return noStoreJson({
    month,
    /** The month has not ended yet: it can be reviewed but not closed. */
    ended: month < currentMonth,
    locked: isMonthLocked(lockedThrough, month),
    lockedThrough,
    items: items.items.filter((item) => item.kind !== "overdue_invoice"),
    totals: items.totals,
    blockingTotal: items.blockingTotal,
    progress: monthProgress(rows),
    hasStatement: statements > 0,
    /** F10: receipts and sales documents dated in the month (any state). */
    receiptCount,
    invoiceCount,
    /** Nothing was recorded in the month: there is nothing to check or close (F10). */
    hasContent: statements + receiptCount + invoiceCount + items.items.length > 0,
    vatRegistered: user?.vatRegistered ?? false,
    vatPeriod: user?.vatPeriod ?? "month",
  });
});
