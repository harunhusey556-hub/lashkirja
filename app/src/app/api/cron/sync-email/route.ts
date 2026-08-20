import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { syncImapAccount } from "@/lib/mail-sync";

import { errorText } from "@/lib/api-errors";
// This route must be protected by a cron secret to prevent abuse
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get("authorization");
  const expectedToken = process.env.CRON_SECRET
    ? `Bearer ${process.env.CRON_SECRET}`
    : null;

  if (expectedToken && authHeader !== expectedToken) {
    return new NextResponse("Unauthorized", { status: 401 });
  }

  try {
    const accounts = await prisma.imapAccount.findMany();
    let totalSynced = 0;
    const errors: Array<{ accountId?: string; email?: string; error: string }> = [];

    for (const account of accounts) {
      try {
        const count = await syncImapAccount(account.id);
        totalSynced += count;
      } catch (err: unknown) {
        console.error(`Failed to sync account ${account.email}:`, err);
        errors.push({ email: account.email, error: errorText(err) });
      }
    }

    return NextResponse.json({
      success: true,
      processedAccounts: accounts.length,
      totalSynced,
      errors: errors.length ? errors : undefined,
    });
  } catch (error: unknown) {
    console.error("Global IMAP sync error:", error);
    return NextResponse.json(
      { success: false, error: "Internal error" },
      { status: 500 }
    );
  }
}
