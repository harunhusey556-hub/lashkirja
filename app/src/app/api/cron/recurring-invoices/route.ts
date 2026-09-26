import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { checkCronAuth } from "@/lib/cron-auth";
import { runRecurringInvoices } from "@/lib/recurring-invoices";
import { sendInvoiceByEmail } from "@/lib/invoice-mail";
import { errorText } from "@/lib/api-errors";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Generates due recurring invoices for every user. One user's failure must not
 * stop the others, so each is caught and reported separately.
 */
export async function GET(req: NextRequest) {
  const auth = checkCronAuth(req);
  if (!auth.ok) return auth.response;

  const users = await prisma.recurringInvoice.findMany({
    where: { active: true, nextRunAt: { not: null } },
    select: { userId: true },
    distinct: ["userId"],
  });

  let generated = 0;
  let skipped = 0;
  const errors: Array<{ userId: string; error: string }> = [];

  for (const { userId } of users) {
    try {
      const result = await runRecurringInvoices(userId, {
        send: (invoiceId) => sendInvoiceByEmail(userId, invoiceId).then(() => undefined),
      });
      generated += result.generated.length;
      skipped += result.skipped.length;
    } catch (error) {
      errors.push({ userId, error: errorText(error) });
    }
  }

  return NextResponse.json({
    ok: errors.length === 0,
    users: users.length,
    generated,
    skipped,
    errors: errors.length ? errors : undefined,
  });
}
