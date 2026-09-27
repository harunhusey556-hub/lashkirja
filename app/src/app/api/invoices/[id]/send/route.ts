import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { previewInvoiceSend, sendInvoiceByEmail } from "@/lib/invoice-mail";
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

    const result = await sendInvoiceByEmail(session.userId, id, body);

    return noStoreJson({
      ok: true,
      sentTo: result.sentTo,
      messageId: result.messageId,
      recorded: result.recorded,
      notice: result.notice,
      invoice: await getInvoice(session.userId, id),
    });
  }
);
