import { NextRequest, NextResponse } from "next/server";
import { guardWrite } from "@/lib/http-security";
import { requireSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { withErrorHandler } from "@/lib/api-errors";

/**
 * Archives the e-mail receipts that wait for review but carry no amount: what an
 * earlier sync brought in before non-bills were archived on arrival. They become
 * "rejected" (restorable from Sähköposti → Arkisto); nothing approved is touched.
 */
export const POST = withErrorHandler(async (req: NextRequest) => {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  const session = await requireSession(req);
  if (!session?.userId) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  const result = await prisma.receipt.updateMany({
    where: {
      userId: session.userId,
      source: "email_sync",
      reviewStatus: "pending",
      OR: [{ totalAmountCents: null }, { totalAmountCents: 0 }],
    },
    data: { reviewStatus: "rejected" },
  });

  return NextResponse.json({ archived: result.count });
});
