import { NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { idempotencyKeyFrom, withIdempotentSideEffect } from "@/lib/idempotency";
import { duplicateInvoice, invoiceBarcodeFields } from "@/lib/sales-invoices";

export const POST = withErrorHandler(
  async (req: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const session = await requireSession(req);
    if (!session) throw new UnauthorizedError();
    const crossSite = rejectCrossSite(req);
    if (crossSite) return crossSite;
    const oversized = rejectOversizedContentLength(req);
    if (oversized) return oversized;
    const { id } = await context.params;
    // A retry of the same tap (answer lost on the way) gets the first copy back instead of
    // a second draft with another invoice number. A new key is a deliberate second copy.
    const outcome = await withIdempotentSideEffect(
      session.userId,
      `invoice-duplicate:${id}`,
      idempotencyKeyFrom(req),
      async () => ({ status: 201, body: { invoice: await duplicateInvoice(session.userId, id) } })
    );
    // The copy opens on this answer, so it carries what the detail route gives next to the invoice.
    // Read after the key is settled: a failure here must not let a retry make a second draft.
    const barcode = await invoiceBarcodeFields(session.userId, outcome.body.invoice.id);
    return noStoreJson({ ...outcome.body, ...barcode }, { status: outcome.status });
  }
);
