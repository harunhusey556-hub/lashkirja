import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { syncImapAccount } from "@/lib/mail-sync";
import { withErrorHandler } from "@/lib/api-errors";

export const POST = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session?.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const accounts = await prisma.imapAccount.findMany({
    where: { userId: session.userId },
  });

  if (accounts.length === 0) {
    return NextResponse.json({ error: "Ei sähköpostiyhteyksiä" }, { status: 404 });
  }

  try {
    let totalCount = 0;
    for (const account of accounts) {
      totalCount += await syncImapAccount(account.id);
    }
    return NextResponse.json({ success: true, count: totalCount });
  } catch (err: any) {
    return NextResponse.json({ error: `Synkronointi epäonnistui: ${err.message}` }, { status: 500 });
  }
});
