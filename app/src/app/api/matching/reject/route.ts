import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { runMatching } from "@/lib/matching";

const rejectSchema = z.object({
  transactionId: z.string().min(1),
  receiptId: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const session = await requireSession();
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  const parsed = rejectSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Virheellinen pyyntö" }, { status: 400 });
  }
  const { transactionId, receiptId } = parsed.data;

  const tx = await prisma.transaction.findFirst({
    where: { id: transactionId, statement: { userId: session.userId! } },
  });
  if (!tx) {
    return NextResponse.json(
      { error: "Tapahtumaa ei löytynyt" },
      { status: 404 }
    );
  }

  await prisma.matchRejection.upsert({
    where: { transactionId_receiptId: { transactionId, receiptId } },
    create: { transactionId, receiptId },
    update: {},
  });

  if (tx.suggestedReceiptId === receiptId) {
    await prisma.transaction.update({
      where: { id: transactionId },
      data: {
        matchStatus: "unmatched",
        suggestedReceiptId: null,
        matchScore: null,
        matchReasons: null,
      },
    });
  }

  // Re-score so the freed receipt / transaction can find their next-best pair
  await runMatching(session.userId!);

  return NextResponse.json({ ok: true });
}
