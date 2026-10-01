import { NextRequest, NextResponse } from "next/server";
import { guardWrite } from "@/lib/http-security";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { withErrorHandler } from "@/lib/api-errors";
import { assertPeriodOpen } from "@/lib/period-lock";
import { SOURCE_DRAFT_REASONS } from "@/lib/matching";

const unlinkSchema = z.object({
  transactionId: z.string().min(1),
});

/**
 * Undo a confirmed link (a wrong confirm must be reversible). When the link was
 * the approval of a sale draft made from this very row ("Hyväksy myynti"), the
 * undo is the whole inverse: the draft goes back to waiting for approval, so the
 * row offers "Hyväksy" again and the sale is out of the books until it is.
 */
export const POST = withErrorHandler(async (req: NextRequest) => {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  const session = await requireSession(req);
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  const parsed = unlinkSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Virheellinen pyyntö" }, { status: 400 });
  }

  const tx = await prisma.transaction.findFirst({
    where: {
      id: parsed.data.transactionId,
      statement: { userId: session.userId! },
    },
  });
  if (!tx) {
    return NextResponse.json(
      { error: "Tapahtumaa ei löytynyt" },
      { status: 404 }
    );
  }

  const linked = tx.receiptId
    ? await prisma.receipt.findFirst({
        where: {
          id: tx.receiptId,
          userId: session.userId!,
          source: "auto_income",
          sourceTransactionId: tx.id,
          reviewStatus: "approved",
        },
        select: { id: true, date: true },
      })
    : null;
  // Taking an approved sale out of the books changes its month.
  if (linked) await assertPeriodOpen(session.userId!, [linked.date]);

  await prisma.$transaction(async (db) => {
    // The sale draft is the row's own sale again, so the row is put back to the
    // state that offers "Hyväksy" at once, not left for the next matching run.
    await db.transaction.update({
      where: { id: tx.id },
      data: linked
        ? {
            receiptId: null,
            matchStatus: "suggested",
            suggestedReceiptId: linked.id,
            matchScore: 1,
            matchReasons: JSON.stringify(SOURCE_DRAFT_REASONS),
          }
        : {
            receiptId: null,
            matchStatus: "unmatched",
            suggestedReceiptId: null,
            matchScore: null,
            matchReasons: null,
          },
    });
    if (linked) {
      await db.receipt.update({ where: { id: linked.id }, data: { reviewStatus: "pending" } });
    }
  });

  return NextResponse.json({ ok: true, restoredSale: linked !== null });
});
