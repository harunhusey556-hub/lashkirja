import { NextRequest, NextResponse } from "next/server";
import { guardWrite } from "@/lib/http-security";
import { requireSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { withErrorHandler } from "@/lib/api-errors";
import { MARKETING_NOTE } from "@/lib/mail-classify";

/**
 * Archives the e-mail receipts that wait for review but carry no amount, or that the AI noted
 * as marketing: what an
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

  // Waiting e-mail receipts that are not bills: no amount, or the AI's note says marketing.
  const waiting = await prisma.receipt.findMany({
    where: { userId: session.userId, source: "email_sync", reviewStatus: "pending" },
    select: { id: true, totalAmountCents: true, notes: true },
  });
  const ids = waiting
    .filter((r) => !r.totalAmountCents || (r.notes !== null && MARKETING_NOTE.test(r.notes)))
    .map((r) => r.id);
  const result = await prisma.receipt.updateMany({
    where: { id: { in: ids }, userId: session.userId, reviewStatus: "pending" },
    data: { reviewStatus: "rejected" },
  });

  return NextResponse.json({ archived: result.count });
});
