import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { requireOwnedRecurring, runRecurringInvoices } from "@/lib/recurring-invoices";
import { sendInvoiceByEmail } from "@/lib/invoice-mail";

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
