import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { runMatching } from "@/lib/matching";
import { autoGenerateIncomeReceipts } from "@/lib/income-automation";
import { prisma } from "@/lib/db";

export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) {
    return NextResponse.json({ error: "Ei kirjautunut" }, { status: 401 });
  }

  try {
    const result = await runMatching(session.userId);

    const statements = await prisma.statement.findMany({
      where: { userId: session.userId },
      select: { id: true }
    });
    let autoIncomeCount = 0;
    for (const stmt of statements) {
      autoIncomeCount += await autoGenerateIncomeReceipts(session.userId, stmt.id);
    }

    if (autoIncomeCount > 0) {
      (result as any).autoConfirmed += autoIncomeCount;
    }

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return NextResponse.json({ error: "Matching failed" }, { status: 500 });
  }
}
