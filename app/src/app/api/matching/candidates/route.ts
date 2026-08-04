import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { candidatesFor } from "@/lib/matching";
import { centsToEuros } from "@/lib/money";

export async function GET(req: NextRequest) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  const transactionId = new URL(req.url).searchParams.get("transactionId");
  if (!transactionId) {
    return NextResponse.json(
      { error: "transactionId puuttuu" },
      { status: 400 }
    );
  }

  const tx = await prisma.transaction.findFirst({
    where: { id: transactionId, statement: { userId: session.userId! } },
  });
  if (!tx) {
    return NextResponse.json(
      { error: "Tapahtumaa ei löytynyt" },
      { status: 404 }
    );
  }

  const [receipts, rejections] = await Promise.all([
    prisma.receipt.findMany({
      where: { userId: session.userId!, linkedTransaction: null },
      select: {
        id: true,
        vendor: true,
        date: true,
        totalAmountCents: true,
        type: true,
        reference: true,
        invoiceNumber: true,
        fileName: true,
      },
    }),
    prisma.matchRejection.findMany({
      where: { transactionId },
      select: { transactionId: true, receiptId: true },
    }),
  ]);

  const rejectedPairs = new Set(
    rejections.map((r) => `${r.transactionId}:${r.receiptId}`)
  );
  const scored = candidatesFor(
    { ...tx, amount: centsToEuros(tx.amountCents) },
    receipts.map(({ totalAmountCents, ...receipt }) => ({
      ...receipt,
      totalAmount: totalAmountCents == null ? null : centsToEuros(totalAmountCents),
    })),
    rejectedPairs
  );
  const byId = new Map(receipts.map((r) => [r.id, r]));

  return NextResponse.json({
    candidates: scored.map((c) => ({
      score: c.score,
      reasons: c.reasons,
      receipt: byId.get(c.receiptId)
        ? {
            ...byId.get(c.receiptId)!,
            totalAmount:
              byId.get(c.receiptId)!.totalAmountCents == null
                ? null
                : centsToEuros(byId.get(c.receiptId)!.totalAmountCents),
          }
        : null,
    })),
  });
}
