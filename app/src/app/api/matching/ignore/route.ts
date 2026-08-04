import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";

const ignoreSchema = z.object({
  transactionId: z.string().min(1),
  ignored: z.boolean().default(true),
});

/** Mark a bank row as "ei kuittia tarvita" (e.g. pankkikulut) — or undo it. */
export async function POST(req: NextRequest) {
  const session = await requireSession();
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
  });
  if (!tx) {
    return NextResponse.json(
      { error: "Tapahtumaa ei löytynyt" },
      { status: 404 }
    );
  }
  if (tx.matchStatus === "confirmed") {
    return NextResponse.json(
      { error: "Poista linkitys ensin" },
      { status: 409 }
    );
  }

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
}
