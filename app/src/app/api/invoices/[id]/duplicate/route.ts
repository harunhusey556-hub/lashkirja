import { NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { idempotencyKeyFrom, withIdempotentSideEffect } from "@/lib/idempotency";
import { duplicateInvoice } from "@/lib/sales-invoices";

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
    return noStoreJson(outcome.body, { status: outcome.status });
  }
);
