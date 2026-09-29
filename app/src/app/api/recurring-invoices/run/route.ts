import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import {
  listRecurringInvoices,
  requireOwnedRecurring,
  runRecurringInvoices,
} from "@/lib/recurring-invoices";
import { sendInvoiceByEmail } from "@/lib/invoice-mail";
import { dueRuns, type RecurrenceInterval } from "@/lib/recurrence";
import { computeInvoiceTotals } from "@/lib/invoices";
import { centsToEuros } from "@/lib/money";

/**
 * What a run would create right now, without creating anything: the
 * confirmation sheet lists it before the user commits (SALES-05). Uses the
 * same catch-up plan as the run itself.
 */
export const GET = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  const only = req.nextUrl.searchParams.get("recurringInvoiceId");
  const today = new Date().toISOString().slice(0, 10);
  const schedules = await listRecurringInvoices(session.userId, { includeInactive: false });
  const plan = schedules
    .filter((entry) => entry.active && entry.nextRunAt && (!only || entry.id === only))
    .map((entry) => {
      const runs = dueRuns(
        {
          interval: entry.interval as RecurrenceInterval,
          anchorDay: entry.anchorDay,
          startDate: entry.startDate.slice(0, 10),
          endDate: entry.endDate ? entry.endDate.slice(0, 10) : null,
        },
        entry.nextRunAt!.slice(0, 10),
        today
      );
      return {
        recurringInvoiceId: entry.id,
        name: entry.name || entry.customer.name,
        customerName: entry.customer.name,
        customerEmail: entry.customer.email,
        autoSend: entry.autoSend,
        // What the customer is billed: VAT included, as on the invoice.
        gross: centsToEuros(
          computeInvoiceTotals(
            entry.lines.map((line) => ({
              quantityMilli: Math.round(line.quantity * 1000),
              unitPriceCents: Math.round(line.unitPrice * 100),
              vatRatePermille: Math.round(line.vatRate * 10),
            }))
          ).grossCents
        ),
        issueDates: runs.dates,
      };
    })
    .filter((entry) => entry.issueDates.length > 0);
  return noStoreJson({ plan });
});

const bodySchema = z
  .object({ recurringInvoiceId: z.string().uuid().optional() })
  .default({});

/** Generates everything owed now. Safe to call twice: runs are idempotent. */
export const POST = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req);
  if (oversized) return oversized;

  const body = bodySchema.parse(await req.json().catch(() => ({})));
  if (body.recurringInvoiceId) {
    await requireOwnedRecurring(session.userId, body.recurringInvoiceId);
  }

  const result = await runRecurringInvoices(session.userId, {
    recurringInvoiceId: body.recurringInvoiceId,
    send: (invoiceId) => sendInvoiceByEmail(session.userId, invoiceId).then(() => undefined),
  });

  return noStoreJson({
    generated: result.generated.map((entry) => ({
      recurringInvoiceId: entry.recurringInvoiceId,
      issueDate: entry.issueDate,
      invoiceId: entry.invoice.id,
      invoiceNumber: entry.invoice.number,
      gross: entry.invoice.gross,
      sent: entry.sent,
      sendError: entry.sendError,
    })),
    skipped: result.skipped,
    truncated: result.truncated,
  });
});
