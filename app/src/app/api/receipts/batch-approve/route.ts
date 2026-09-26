import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { runMatching } from "@/lib/matching";

const batchApproveSchema = z.object({
  receiptIds: z.array(z.string().uuid()).min(1).max(200),
});

export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  try {
    const body = batchApproveSchema.parse(await req.json());
    
    // Only update receipts that belong to the user and are currently pending
    const updateResult = await prisma.receipt.updateMany({
      where: {
        id: { in: body.receiptIds },
        userId: session.userId,
        reviewStatus: "pending",
      },
      data: {
        reviewStatus: "approved",
      },
    });

    // Auto-link: find all just-approved receipts that have a sourceTransactionId
    // and link them to their originating bank transaction in one pass.
    let autoLinkedCount = 0;
    if (updateResult.count > 0) {
      const approvedWithSource = await prisma.receipt.findMany({
        where: {
          id: { in: body.receiptIds },
          userId: session.userId,
          reviewStatus: "approved",
          sourceTransactionId: { not: null },
        },
        select: { id: true, sourceTransactionId: true },
      });

      for (const receipt of approvedWithSource) {
        try {
          const tx = await prisma.transaction.findFirst({
            where: {
              id: receipt.sourceTransactionId!,
              statement: { userId: session.userId },
              receiptId: null, // not already linked
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
                suggestedReceiptId: tx.suggestedReceiptId === receipt.id ? null : tx.suggestedReceiptId,
              },
            });
            autoLinkedCount++;
          }
        } catch (e) {
          console.error(`Auto-link failed for receipt ${receipt.id}:`, e);
        }
      }

      // Run matching for any remaining non-income receipts
      await runMatching(session.userId).catch(console.error);
    }

    return NextResponse.json({
      ok: true,
      updatedCount: updateResult.count,
      autoLinkedCount,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: "Virheellinen data" }, { status: 400 });
    }
    console.error("Batch approve failed:", error);
    return NextResponse.json({ error: "Hyväksyntä epäonnistui" }, { status: 500 });
  }
}
