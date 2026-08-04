import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { centsToEuros } from "@/lib/money";

/** Reconciliation view: bank rows without a confirmed receipt and receipts
 *  without a bank link, for one kohdekuukausi. */
export async function GET(req: NextRequest) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  const month =
    new URL(req.url).searchParams.get("month") ||
    new Date().toISOString().slice(0, 7);
  const [year, monthNum] = month.split("-").map(Number);
  const startOfMonth = new Date(Date.UTC(year, monthNum - 1, 1));
  const endOfMonth = new Date(Date.UTC(year, monthNum, 1));

  const [unmatchedTx, unlinkedReceipts] = await Promise.all([
    prisma.transaction.findMany({
      where: {
        statement: { userId: session.userId!, periodMonth: month },
        matchStatus: { in: ["unmatched", "suggested"] },
        type: { in: ["tulo", "meno"] },
      },
      select: {
        id: true,
        date: true,
        counterparty: true,
        amountCents: true,
        type: true,
        matchStatus: true,
      },
      orderBy: { date: "asc" },
    }),
    prisma.receipt.findMany({
      where: {
        userId: session.userId!,
        linkedTransaction: null,
        date: { gte: startOfMonth, lt: endOfMonth },
      },
      select: {
        id: true,
        vendor: true,
        date: true,
        totalAmountCents: true,
        type: true,
      },
      orderBy: { date: "asc" },
    }),
  ]);

  return NextResponse.json({
    month,
    unmatchedTx: unmatchedTx.map(({ amountCents, ...tx }) => ({
      ...tx,
      amount: centsToEuros(amountCents),
    })),
    unlinkedReceipts: unlinkedReceipts.map(({ totalAmountCents, ...receipt }) => ({
      ...receipt,
      totalAmount: totalAmountCents == null ? null : centsToEuros(totalAmountCents),
    })),
  });
}
