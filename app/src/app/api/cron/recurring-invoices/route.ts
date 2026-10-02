import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { checkCronAuth } from "@/lib/cron-auth";
import { runRecurringInvoices } from "@/lib/recurring-invoices";
import { runDueRecurringPurchases, type DueRecurringPurchasesSummary } from "@/lib/recurring-purchases";
import { sendInvoiceByEmail } from "@/lib/invoice-mail";
import { errorText } from "@/lib/api-errors";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Generates due recurring invoices for every user, then the due recurring
 * purchase invoices (toistuvat ostolaskut). One user's failure must not stop
 * the others, so each is caught and reported separately.
 */
export async function GET(req: NextRequest) {
  const auth = checkCronAuth(req);
  if (!auth.ok) return auth.response;

  const users = await prisma.recurringInvoice.findMany({
    // Not only schedules with a run due: a month that opened again or a mail
    // to retry belongs to a schedule that is not due.
    where: { active: true, user: { accessDisabledAt: null } },
    select: { userId: true },
    distinct: ["userId"],
  });

  let generated = 0;
  let skipped = 0;
  let resent = 0;
  // An invoice that was made but not mailed is not a plain success: it sits as
  // a draft until a retry or a person sends it, so the answer says so.
  const sendErrors: Array<{ userId: string; recurringInvoiceId: string; invoiceId: string; error: string }> = [];
  const errors: Array<{ userId: string; error: string }> = [];

  for (const { userId } of users) {
    try {
      const result = await runRecurringInvoices(userId, {
        send: (invoiceId) => sendInvoiceByEmail(userId, invoiceId).then(() => undefined),
      });
      generated += result.generated.length;
      skipped += result.skipped.length;
      resent += result.sendRetries.filter((retry) => retry.sent).length;
      for (const entry of result.generated) {
        if (entry.sendError) {
          sendErrors.push({
            userId,
            recurringInvoiceId: entry.recurringInvoiceId,
            invoiceId: entry.invoice.id,
            error: entry.sendError,
          });
        }
      }
      for (const retry of result.sendRetries) {
        if (!retry.sent && retry.sendError) {
          sendErrors.push({
            userId,
            recurringInvoiceId: retry.recurringInvoiceId,
            invoiceId: retry.invoiceId,
            error: retry.sendError,
          });
        }
      }
    } catch (error) {
      errors.push({ userId, error: errorText(error) });
    }
  }

  let purchases: DueRecurringPurchasesSummary | { error: string };
  try {
    purchases = await runDueRecurringPurchases();
  } catch (error) {
    purchases = { error: errorText(error) };
  }
  const purchasesOk = !("error" in purchases) && purchases.errors.length === 0 && purchases.failed.length === 0;

  return NextResponse.json({
    ok: errors.length === 0 && sendErrors.length === 0 && purchasesOk,
    users: users.length,
    generated,
    skipped,
    resent,
    sendFailed: sendErrors.length,
    sendErrors: sendErrors.length ? sendErrors : undefined,
    errors: errors.length ? errors : undefined,
    purchases,
  });
}
