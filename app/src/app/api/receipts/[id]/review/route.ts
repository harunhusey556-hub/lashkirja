import { NextRequest, NextResponse } from "next/server";
import { guardWrite } from "@/lib/http-security";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { z } from "zod";
import { withErrorHandler, AppError } from "@/lib/api-errors";
import { serverApprovalBlock } from "@/lib/receipt-approval";
import { assertPeriodOpen } from "@/lib/period-lock";

const reviewSchema = z.object({
  reviewStatus: z.enum(["approved", "rejected", "pending"]),
});

export const PATCH = withErrorHandler(
  async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
    const session = await requireSession(req);
    if (!session) {
      return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
    }

    const { id } = await params;
    if (!id) {
      throw new AppError("Kuittia ei löydy", "NOT_FOUND", 404);
    }

    const json = await req.json();
    const parsed = reviewSchema.parse(json);

    const receipt = await prisma.receipt.findFirst({
      where: { id, userId: session.userId },
    });

    if (!receipt) {
      throw new AppError("Kuittia ei löydy", "NOT_FOUND", 404);
    }

    // TF-02 / FP-6: a receipt with no amount would be booked as 0,00 € and
    // silently drop out of the VAT return. The one-tap path used to allow it.
    if (parsed.reviewStatus === "approved") {
      const incomplete = serverApprovalBlock(receipt);
      if (incomplete) throw new AppError(incomplete, "RECEIPT_INCOMPLETE", 422);
      // Approving books the receipt into its month: a closed month must not move.
      await assertPeriodOpen(session.userId, [receipt.date]);
    }

    // Restoring a rejected receipt puts it back in the review queue (F38). It is
    // not in the books while rejected, so no period lock applies; an approved
    // receipt is not sent back this way.
    if (parsed.reviewStatus === "pending" && receipt.reviewStatus === "approved") {
      throw new AppError("Kuitti on jo hyväksytty.", "CONFLICT", 409);
    }

    // A receipt that is linked to a transaction is part of bookkeeping.
    // It shouldn't be markable as "rejected" unless it's unlinked first.
    if (parsed.reviewStatus === "rejected") {
      // Rejecting an approved receipt takes it out of the books, which moves a
      // closed month's VAT return as much as editing or deleting it would (F06).
      // A pending receipt is not in the books yet, so it may still be rejected.
      if (receipt.reviewStatus === "approved") {
        await assertPeriodOpen(session.userId, [receipt.date]);
      }
      const isLinked = await prisma.transaction.findFirst({
        where: { receiptId: receipt.id },
      });
      if (isLinked) {
        throw new AppError(
          "Kuitti on kohdistettu pankkitapahtumaan. Irrota kuitti ensin, jotta voit hylätä sen.",
          "CONFLICT",
          409
        );
      }
    }

    const updated = await prisma.receipt.update({
      where: { id: receipt.id },
      data: { reviewStatus: parsed.reviewStatus },
    });

    // Auto-link: if this was an auto-generated income draft that just got
    // approved, link it to the bank transaction it was created from.
    let autoLinked = false;
    if (parsed.reviewStatus === "approved" && receipt.sourceTransactionId) {
      try {
        const tx = await prisma.transaction.findFirst({
          where: {
            id: receipt.sourceTransactionId,
            statement: { userId: session.userId },
            receiptId: null, // not already linked to something else
          },
        });
        if (tx) {
          await prisma.transaction.update({
            where: { id: tx.id },
            data: {
              receiptId: receipt.id,
              matchStatus: "confirmed",
              matchScore: 1.0,
              matchReasons: JSON.stringify(["auto_income", "approved"]),
              // Clear any stale suggestion
              suggestedReceiptId: tx.suggestedReceiptId === receipt.id ? null : tx.suggestedReceiptId,
            },
          });
          autoLinked = true;
        }
      } catch (e) {
        console.error("Auto-link after approval failed:", e);
      }
    }

    return NextResponse.json({ success: true, reviewStatus: updated.reviewStatus, autoLinked });
  }
);
