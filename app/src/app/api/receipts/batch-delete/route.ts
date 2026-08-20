import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { removeUserUpload } from "@/lib/storage";
import {
  noStoreJson,
  rejectCrossSite,
} from "@/lib/http-security";
import { withErrorHandler, UnauthorizedError } from "@/lib/api-errors";

const batchDeleteSchema = z.object({
  receiptIds: z.array(z.string()).min(1).max(50),
});

export const POST = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError("Ei kirjautunut");
  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;

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
    },
  });

  if (existingReceipts.length === 0) {
    return noStoreJson({ ok: true }); // None found that belong to user, just return OK
  }

  const validIds = existingReceipts.map((r) => r.id);
  const uploadIds = existingReceipts.map((r) => r.uploadId).filter((id): id is string => id !== null);
  const filePaths = existingReceipts.map((r) => r.filePath);

  await prisma.$transaction(async (db) => {
    // 1. Unlink any transactions associated with these receipts
    await db.transaction.updateMany({
      where: {
        statement: { userId: session.userId! },
        OR: [{ receiptId: { in: validIds } }, { suggestedReceiptId: { in: validIds } }],
      },
      data: {
        receiptId: null,
        suggestedReceiptId: null,
        matchStatus: "unmatched",
        matchScore: null,
        matchReasons: null,
      },
    });

    // 2. Delete the receipts
    await db.receipt.deleteMany({
      where: { id: { in: validIds } },
    });

    // 3. Delete associated upload records
    if (uploadIds.length > 0) {
      await db.upload.deleteMany({
        where: { id: { in: uploadIds }, userId: session.userId! },
      });
    }
  });

  // 4. Cleanup files from storage
  await Promise.allSettled(
    filePaths.map((filePath) =>
      removeUserUpload(session.userId!, filePath, true).catch((error) =>
        console.error(`Batch receipt file cleanup failed for ${filePath}:`, error)
      )
    )
  );

  return noStoreJson({ ok: true, deletedCount: validIds.length });
});
