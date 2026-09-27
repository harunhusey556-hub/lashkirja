import { NextRequest, NextResponse } from "next/server";
import { guardWrite } from "@/lib/http-security";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";

const unlinkSchema = z.object({
  transactionId: z.string().min(1),
});

/** Undo a confirmed link (a wrong confirm must be reversible). */
export async function POST(req: NextRequest) {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  const session = await requireSession();
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

  await prisma.transaction.update({
    where: { id: tx.id },
    data: {
      receiptId: null,
      matchStatus: "unmatched",
      suggestedReceiptId: null,
      matchScore: null,
      matchReasons: null,
    },
  });

  return NextResponse.json({ ok: true });
}
