import { NextRequest, NextResponse } from "next/server";
import { guardWrite } from "@/lib/http-security";
import { requireSession } from "@/lib/session";
import { runMatching } from "@/lib/matching";
import { autoGenerateIncomeReceipts } from "@/lib/income-automation";
import { prisma } from "@/lib/db";

export async function POST(req: NextRequest) {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
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

    // A draft is not a link: the matcher's own count stays "linked
    // automatically", and the drafts made are reported as their own number.
    return NextResponse.json({ ok: true, ...result, draftsCreated: autoIncomeCount });
  } catch (error) {
    return NextResponse.json({ error: "Matching failed" }, { status: 500 });
  }
}
