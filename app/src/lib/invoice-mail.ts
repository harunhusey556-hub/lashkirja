/**
 * Emailing a sales invoice. Shared by the manual "send" action and by
 * automatic sending from a recurring schedule, so both compose the same
 * message and enforce the same preconditions.
 */
import { AppError, ValidationError } from "./api-errors";
import { formatEur } from "./format";
import { formatReference } from "./finnish-reference";
import { renderInvoicePdf } from "./invoice-pdf";
import { findSenderAccount, sendMail } from "./mailer";
import {
  buildInvoicePdfData,
  getInvoice,
  invoicePdfFileName,
  setInvoiceStatus,
} from "./sales-invoices";

export interface SendInvoiceInput {
  to?: string;
  subject?: string;
  message?: string;
}

export interface SendInvoiceResult {
  sentTo: string;
  messageId: string;
  invoiceNumber: number;
  attachment: string;
  statusChanged: boolean;
}

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
 * Sends the invoice and moves a draft to sent. The status only changes after
 * the mail server has accepted the message: sending is what makes an invoice
 * real, so a failed send must leave a draft a draft.
 */
export async function sendInvoiceByEmail(
  userId: string,
  invoiceId: string,
  input: SendInvoiceInput = {}
): Promise<SendInvoiceResult> {
  const invoice = await getInvoice(userId, invoiceId);
  if (invoice.status === "credited") {
    throw new AppError("Hyvitettyä laskua ei lähetetä.", "INVOICE_CREDITED", 409);
  }

  const to = input.to ?? invoice.customer.email;
  if (!to) {
    throw new ValidationError(
      "Asiakkaalla ei ole sähköpostiosoitetta. Lisää se asiakastietoihin tai anna osoite."
    );
  }

  const account = await findSenderAccount(userId);
  if (!account) {
    throw new AppError(
      "Lähettävää sähköpostitiliä ei ole yhdistetty. Lisää tili asetuksista.",
      "NO_MAIL_ACCOUNT",
      409
    );
  }

  const data = await buildInvoicePdfData(userId, invoiceId);
  const pdf = await renderInvoicePdf(data);

  const sent = await sendMail(account, {
    to,
    subject: input.subject ?? `Lasku ${invoice.number} · ${data.seller.name}`,
    text:
      input.message ??
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

  let statusChanged = false;
  if (invoice.status === "draft") {
    await setInvoiceStatus(userId, invoiceId, "sent");
    statusChanged = true;
  }

  return {
    sentTo: sent.to,
    messageId: sent.messageId,
    invoiceNumber: invoice.number,
    attachment: invoicePdfFileName(invoice.number),
    statusChanged,
  };
}
