import { NextRequest, NextResponse } from "next/server";
import { guardWrite } from "@/lib/http-security";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { withErrorHandler } from "@/lib/api-errors";
import { assertMonthOpen, assertPeriodOpen } from "@/lib/period-lock";

const ignoreSchema = z.object({
  transactionId: z.string().min(1),
  ignored: z.boolean().default(true),
});

/** Mark a bank row as "ei kuittia tarvita" (e.g. pankkikulut) — or undo it. */
export const POST = withErrorHandler(async (req: NextRequest) => {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  const session = await requireSession(req);
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  const parsed = ignoreSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Virheellinen pyyntö" }, { status: 400 });
  }
  const { transactionId, ignored } = parsed.data;

  const tx = await prisma.transaction.findFirst({
    where: { id: transactionId, statement: { userId: session.userId! } },
    include: { statement: { select: { periodMonth: true } } },
  });
  if (!tx) {
    return NextResponse.json(
      { error: "Tapahtumaa ei löytynyt" },
      { status: 404 }
    );
  }
  if (tx.matchStatus === "confirmed") {
    return NextResponse.json(
      { error: "Poista kohdistus ensin" },
      { status: 409 }
    );
  }

  // Marking a row changes what the month still needs: a closed month is left alone.
  if (tx.statement.periodMonth) await assertMonthOpen(session.userId!, tx.statement.periodMonth);
  await assertPeriodOpen(session.userId!, [tx.date]);

  await prisma.transaction.update({
    where: { id: transactionId },
    data: {
      matchStatus: ignored ? "ignored" : "unmatched",
      suggestedReceiptId: null,
      matchScore: null,
      matchReasons: null,
    },
  });

  return NextResponse.json({ ok: true });
});
