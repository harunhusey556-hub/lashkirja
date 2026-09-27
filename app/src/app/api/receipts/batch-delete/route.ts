import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { removeUserUpload } from "@/lib/storage";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { withErrorHandler, UnauthorizedError, AppError } from "@/lib/api-errors";
import { assertPeriodOpen } from "@/lib/period-lock";

const batchDeleteSchema = z.object({
  receiptIds: z.array(z.string()).min(1).max(50),
});

export const POST = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError("Ei kirjautunut");
  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req);
  if (oversized) return oversized;

  const parsed = batchDeleteSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return noStoreJson({ error: "Virheelliset tiedot" }, { status: 400 });
  }

  const { receiptIds } = parsed.data;
  const existingReceipts = await prisma.receipt.findMany({
    where: {
      id: { in: receiptIds },
      userId: session.userId!,
    },
    select: {
      id: true,
      filePath: true,
      uploadId: true,
      date: true,
    },
  });
  const byId = new Map(existingReceipts.map((receipt) => [receipt.id, receipt]));
  const succeeded: string[] = [];
  const failed: { id: string; error: string }[] = [];
  const removedPaths: string[] = [];

  for (const id of receiptIds) {
    const receipt = byId.get(id);
    if (!receipt) {
      failed.push({ id, error: "Kuittia ei löytynyt" });
      continue;
    }
    try {
      await assertPeriodOpen(session.userId!, [receipt.date]);
      await prisma.$transaction(async (db) => {
        await db.transaction.updateMany({
          where: {
            statement: { userId: session.userId! },
            OR: [{ receiptId: receipt.id }, { suggestedReceiptId: receipt.id }],
          },
          data: {
            receiptId: null,
            suggestedReceiptId: null,
            matchStatus: "unmatched",
            matchScore: null,
            matchReasons: null,
          },
        });
        await db.receipt.delete({ where: { id: receipt.id } });
        if (receipt.uploadId) {
          await db.upload.deleteMany({
            where: { id: receipt.uploadId, userId: session.userId! },
          });
        }
      });
      succeeded.push(receipt.id);
      removedPaths.push(receipt.filePath);
    } catch (error) {
      failed.push({
        id,
        error: error instanceof AppError ? error.message : "Poisto epäonnistui",
      });
    }
  }

  await Promise.allSettled(
    removedPaths.map((filePath) =>
      removeUserUpload(session.userId!, filePath, true).catch((error) =>
        console.error(`Batch receipt file cleanup failed for ${filePath}:`, error)
      )
    )
  );

  return noStoreJson({
    ok: true,
    succeeded,
    failed,
    deletedCount: succeeded.length,
    failedCount: failed.length,
  });
});
