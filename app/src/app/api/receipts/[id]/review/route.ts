import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { z } from "zod";
import { withErrorHandler, AppError } from "@/lib/api-errors";

const reviewSchema = z.object({
  reviewStatus: z.enum(["approved", "rejected"]),
});

export const PATCH = withErrorHandler(
  async (req: NextRequest, { params }: { params: { id: string } }) => {
    const session = await requireSession(req);
    if (!session) {
      return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
    }

    const json = await req.json();
    const parsed = reviewSchema.parse(json);

    const receipt = await prisma.receipt.findFirst({
      where: { id: params.id, userId: session.userId },
    });

    if (!receipt) {
      throw new AppError("Kuittia ei löydy", "NOT_FOUND", 404);
    }

    // A receipt that is linked to a transaction is part of bookkeeping. 
    // It shouldn't be markable as "rejected" unless it's unlinked first.
    if (parsed.reviewStatus === "rejected") {
      const isLinked = await prisma.transaction.findFirst({
        where: { receiptId: receipt.id },
      });
      if (isLinked) {
        throw new AppError(
          "Kuitti on linkitetty tiliotetapahtumaan. Irrota kuitti ensin, jotta voit hylätä sen.",
          "CONFLICT",
          409
        );
      }
    }

    const updated = await prisma.receipt.update({
      where: { id: receipt.id },
      data: { reviewStatus: parsed.reviewStatus },
    });

    return NextResponse.json({ success: true, reviewStatus: updated.reviewStatus });
  }
);
