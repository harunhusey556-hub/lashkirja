import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { previewInvoiceSend, sendInvoiceByEmail } from "@/lib/invoice-mail";
import { hashIdempotencyPayload, idempotencyKeyFrom, withIdempotentSideEffect } from "@/lib/idempotency";
import { getInvoice } from "@/lib/sales-invoices";

const bodySchema = z
  .object({
    to: z.string().trim().email().max(160).optional(),
    subject: z.string().trim().min(1).max(200).optional(),
    message: z.string().trim().max(4000).optional(),
  })
  .default({});

export const GET = withErrorHandler(
  async (req: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const session = await requireSession(req);
    if (!session) throw new UnauthorizedError();
    const { id } = await context.params;
    return noStoreJson({ preview: await previewInvoiceSend(session.userId, id) });
  }
);

export const POST = withErrorHandler(
  async (req: NextRequest, context: { params: Promise<{ id: string }> }) => {
    const session = await requireSession(req);
    if (!session) throw new UnauthorizedError();

    const crossSite = rejectCrossSite(req);
    if (crossSite) return crossSite;
    const oversized = rejectOversizedContentLength(req);
    if (oversized) return oversized;

    const { id } = await context.params;
    const body = bodySchema.parse(await req.json().catch(() => ({})));

    // The sheet sends one key per send. When the answer is lost on the way and
    // the person taps again, the retry gets the first answer back and the mail
    // is not sent a second time (G04). A new key is a deliberate resend.
    const outcome = await withIdempotentSideEffect(
      session.userId,
      `invoice-send:${id}`,
      idempotencyKeyFrom(req),
      async () => {
        const result = await sendInvoiceByEmail(session.userId, id, body);
        return {
          status: 200,
          body: {
            ok: true,
            sentTo: result.sentTo,
            messageId: result.messageId,
            recorded: result.recorded,
            notice: result.notice,
            invoice: await getInvoice(session.userId, id),
          },
        };
      },
      hashIdempotencyPayload(body)
    );

    return noStoreJson(outcome.replayed ? { ...outcome.body, replayed: true } : outcome.body, {
      status: outcome.status,
    });
  }
);
