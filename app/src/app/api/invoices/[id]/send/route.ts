import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { AppError, UnauthorizedError, ValidationError, withErrorHandler } from "@/lib/api-errors";
import {
  buildInvoicePdfData,
  getInvoice,
  invoicePdfFileName,
  setInvoiceStatus,
} from "@/lib/sales-invoices";
import { renderInvoicePdf } from "@/lib/invoice-pdf";
import { findSenderAccount, sendMail } from "@/lib/mailer";
import { formatEur } from "@/lib/format";
import { formatReference } from "@/lib/finnish-reference";

const bodySchema = z
  .object({
    to: z.string().trim().email().max(160).optional(),
    subject: z.string().trim().min(1).max(200).optional(),
    message: z.string().trim().max(4000).optional(),
  })
  .default({});

function defaultMessage(data: {
  number: number;
  gross: string;
  dueDate: string;
  reference: string;
  sellerName: string;
}): string {
  return [
    "Hei,",
    "",
    `liitteenä lasku ${data.number}.`,
    "",
    `Summa: ${data.gross}`,
    `Eräpäivä: ${data.dueDate}`,
    `Viitenumero: ${data.reference}`,
    "",
    "Kiitos!",
    data.sellerName,
  ].join("\n");
}

/**
 * Emails the invoice PDF to the customer and marks a draft as sent.
 *
 * Sending is what makes an invoice real, so the status only moves after the
 * mail server has accepted the message.
 */
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

    const invoice = await getInvoice(session.userId, id);
    if (invoice.status === "credited") {
      throw new AppError("Hyvitettyä laskua ei lähetetä.", "INVOICE_CREDITED", 409);
    }

    const to = body.to ?? invoice.customer.email;
    if (!to) {
      throw new ValidationError(
        "Asiakkaalla ei ole sähköpostiosoitetta. Lisää se asiakastietoihin tai anna osoite."
      );
    }

    const account = await findSenderAccount(session.userId);
    if (!account) {
      throw new AppError(
        "Lähettävää sähköpostitiliä ei ole yhdistetty. Lisää tili asetuksista.",
        "NO_MAIL_ACCOUNT",
        409
      );
    }

    const data = await buildInvoicePdfData(session.userId, id);
    const pdf = await renderInvoicePdf(data);

    const sent = await sendMail(account, {
      to,
      subject: body.subject ?? `Lasku ${invoice.number} · ${data.seller.name}`,
      text:
        body.message ??
        defaultMessage({
          number: invoice.number,
          gross: formatEur(invoice.gross),
          dueDate: invoice.dueDate,
          reference: formatReference(invoice.reference),
          sellerName: data.seller.name,
        }),
      attachments: [
        {
          filename: invoicePdfFileName(invoice.number),
          content: pdf,
          contentType: "application/pdf",
        },
      ],
    });

    const updated =
      invoice.status === "draft"
        ? await setInvoiceStatus(session.userId, id, "sent")
        : invoice;

    return noStoreJson({
      ok: true,
      sentTo: sent.to,
      messageId: sent.messageId,
      invoice: updated,
    });
  }
);
