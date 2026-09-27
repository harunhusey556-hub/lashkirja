import { NextRequest, NextResponse } from "next/server";
import { guardWrite } from "@/lib/http-security";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { runMatching } from "@/lib/matching";

const batchApproveSchema = z.object({
  receiptIds: z.array(z.string().uuid()).min(1).max(200),
});

export async function POST(req: NextRequest) {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  const session = await requireSession(req);
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  try {
    const body = batchApproveSchema.parse(await req.json());
    const succeeded: string[] = [];
    const failed: { id: string; error: string }[] = [];
    let autoLinkedCount = 0;

    for (const id of body.receiptIds) {
      const receipt = await prisma.receipt.findFirst({
        where: { id, userId: session.userId },
        select: { id: true, reviewStatus: true, sourceTransactionId: true },
      });
      if (!receipt) {
        failed.push({ id, error: "Kuittia ei löytynyt" });
        continue;
      }
      if (receipt.reviewStatus !== "pending") {
        failed.push({ id, error: "Kuitti ei ole tarkastettavana" });
        continue;
      }

      await prisma.receipt.update({
        where: { id: receipt.id },
        data: { reviewStatus: "approved" },
      });
      succeeded.push(receipt.id);

      if (!receipt.sourceTransactionId) continue;
      try {
        const tx = await prisma.transaction.findFirst({
          where: {
            id: receipt.sourceTransactionId,
            statement: { userId: session.userId },
            receiptId: null,
          },
        });
        if (!tx) continue;
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
        await prisma.automationEvent.create({
          data: {
            userId: session.userId,
            kind: "match",
            resourceType: "transaction",
            resourceId: tx.id,
            previousValue: tx.matchStatus,
            newValue: "confirmed",
            reason: "automaattinen hyväksyntä",
          },
        });
        autoLinkedCount += 1;
      } catch (error) {
        console.error(`Auto-link failed for receipt ${receipt.id}:`, error);
        await prisma.automationEvent
          .create({
            data: {
              userId: session.userId,
              kind: "link_error",
              resourceType: "receipt",
              resourceId: receipt.id,
              previousValue: null,
              newValue: receipt.sourceTransactionId,
              reason: "Automaattinen linkitys epäonnistui",
            },
          })
          .catch(() => {});
      }
    }

    if (succeeded.length > 0) {
      await runMatching(session.userId).catch(console.error);
    }

    return NextResponse.json({
      ok: true,
      succeeded,
      failed,
      updatedCount: succeeded.length,
      failedCount: failed.length,
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
