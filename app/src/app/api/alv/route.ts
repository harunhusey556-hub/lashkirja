import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { computeAlvReport } from "@/lib/alv";
import { OMAVERO_FIELDS } from "@/lib/vero/omavero-fields";

export async function GET(req: NextRequest) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  const period = new URL(req.url).searchParams.get("period") || "";

  let startDate: Date;
  let endDate: Date;

  if (period.includes("Q")) {
    const [yearStr, qStr] = period.split("-Q");
    const year = parseInt(yearStr);
    const quarter = parseInt(qStr);
    startDate = new Date(year, (quarter - 1) * 3, 1);
    endDate = new Date(year, quarter * 3, 1);
  } else {
    const [yearStr, monthStr] = period.split("-");
    const year = parseInt(yearStr) || new Date().getFullYear();
    const month = parseInt(monthStr) || new Date().getMonth() + 1;
    startDate = new Date(year, month - 1, 1);
    endDate = new Date(year, month, 1);
  }

  const [user, receipts] = await Promise.all([
    prisma.user.findUnique({ where: { id: session.userId } }),
    prisma.receipt.findMany({
      where: {
        userId: session.userId,
        date: { gte: startDate, lt: endDate },
      },
    }),
  ]);

  const report = computeAlvReport(receipts);

  return NextResponse.json({
    period: { start: startDate.toISOString(), end: endDate.toISOString() },
    vatRegistered: user?.vatRegistered ?? false,
    field301: { label: OMAVERO_FIELDS[301], ...report.field301 },
    field302: { label: OMAVERO_FIELDS[302], ...report.field302 },
    field303: { label: OMAVERO_FIELDS[303], ...report.field303 },
    field309: { label: OMAVERO_FIELDS[309], ...report.field309 },
    field307: { label: OMAVERO_FIELDS[307], ...report.field307 },
    field308: { label: OMAVERO_FIELDS[308], ...report.field308 },
    review: report.review,
    receiptCount: receipts.length,
  });
}
