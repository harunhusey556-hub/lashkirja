import { NextRequest, NextResponse } from "next/server";
import { guardWrite } from "@/lib/http-security";
import { requireSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { syncImapAccount } from "@/lib/mail-sync";
import { withErrorHandler, errorText } from "@/lib/api-errors";

export const POST = withErrorHandler(async (req: NextRequest) => {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
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
  } catch (err: unknown) {
    console.error("[imap sync]", errorText(err));
    return NextResponse.json(
      { error: "Sähköpostien synkronointi epäonnistui. Yritä myöhemmin uudelleen." },
      { status: 500 }
    );
  }
});
