import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { hashIdempotencyPayload, idempotencyKeyFrom, withIdempotentSideEffect } from "@/lib/idempotency";
import { createCreditNote, type CreateCreditNoteInput } from "@/lib/sales-invoices";

const creditLineSchema = z.object({
  lineId: z.string().uuid(),
  /** Units of the original line to reverse, up to three decimals. */
  quantity: z.number().finite().positive(),
});
// `lines` is optional: an empty body, or one without it, is the full remaining
// credit — the shape the detail page used before a part could be chosen.
const bodySchema = z
  .object({ lines: z.array(creditLineSchema).min(1).max(200).optional() })
  .strict();

export const POST = withErrorHandler(
  async (req: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const session = await requireSession(req);
    if (!session) throw new UnauthorizedError();
    const crossSite = rejectCrossSite(req);
    if (crossSite) return crossSite;
    const oversized = rejectOversizedContentLength(req);
    if (oversized) return oversized;
    const { id } = await context.params;
    // No body is the full remaining credit; a JSON body picks the lines and
    // quantities to reverse. Anything else is refused, never defaulted.
    const text = await req.text();
    const input: CreateCreditNoteInput | undefined =
      text.trim() === "" ? undefined : bodySchema.parse(JSON.parse(text));
    // A retry of the same tap gets the first note back instead of a second
    // credit; the remainder checks stop a deliberately different one. A new
    // key (the UI issues one per changed selection) is a deliberate new credit.
    const outcome = await withIdempotentSideEffect(
      session.userId,
      `invoice-credit:${id}`,
      idempotencyKeyFrom(req),
      async () => ({ status: 201, body: { invoice: await createCreditNote(session.userId, id, input) } }),
      hashIdempotencyPayload(input ?? null)
    );
    return noStoreJson(outcome.body, { status: outcome.status });
  }
);
