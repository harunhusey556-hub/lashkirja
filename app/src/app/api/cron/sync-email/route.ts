import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { syncImapAccount } from "@/lib/mail-sync";

import { errorText } from "@/lib/api-errors";
import { checkCronAuth } from "@/lib/cron-auth";
// Runs for every connected account, so it is never left unauthenticated in
// production: checkCronAuth refuses when CRON_SECRET is not configured.
export async function GET(req: NextRequest) {
  const auth = checkCronAuth(req);
  if (!auth.ok) return auth.response;

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
