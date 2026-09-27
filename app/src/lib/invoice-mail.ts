/**
 * Emailing a sales invoice. Shared by the manual "send" action and by
 * automatic sending from a recurring schedule, so both compose the same
 * message and enforce the same preconditions.
 *
 * Period lock and the other refusals run before SMTP. The attempt is stored
 * first. After the server accepts the message, the outcome is written again.
 * If that write fails, the caller still reports that the mail left.
 */
import { AppError, ValidationError } from "./api-errors";
import { formatEur } from "./format";
import { formatReference } from "./finnish-reference";
import { renderInvoicePdf, type InvoicePdfData } from "./invoice-pdf";
import { missingSellerSendFields, parsePartySnapshot } from "./invoice-snapshot";
import { findSenderAccount, sendMail, type MailSenderAccount, type SentMail } from "./mailer";
import { assertPeriodOpen } from "./period-lock";
import {
  buildInvoicePdfData,
  capturePartySnapshot,
  getInvoice,
  invoicePdfFileName,
} from "./sales-invoices";
import { prisma } from "./db";

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
  /** False only when SMTP accepted the message and the outcome could not be stored. */
  recorded: boolean;
  notice: string | null;
}

function defaultMessage(data: {
  number: number;
  gross: string;
  dueDate: string;
  reference: string;
  sellerName: string;
  creditNote?: boolean;
}): string {
  return [
    "Hei,",
    "",
    data.creditNote ? `liitteenä hyvityslasku ${data.number}.` : `liitteenä lasku ${data.number}.`,
    "",
    `Summa: ${data.gross}`,
    `Eräpäivä: ${data.dueDate}`,
    `Viitenumero: ${data.reference}`,
    "",
    "Kiitos!",
    data.sellerName,
  ].join("\n");
}

const UNRECORDED_NOTICE =
  "Viesti lähti, mutta lähetyksen kirjausta ei saatu tallennettua. Älä lähetä samaa laskua uudelleen ennen tarkistusta.";

async function persistAcceptedMail(input: {
  sendId: string;
  invoiceId: string;
  messageId: string;
  wasDraft: boolean;
  partySnapshot: string;
}): Promise<boolean> {
  const invoiceData: Record<string, unknown> = { partySnapshot: input.partySnapshot };
  if (input.wasDraft) {
    invoiceData.status = "sent";
    invoiceData.sentAt = new Date();
    invoiceData.paidAt = null;
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await prisma.$transaction([
        prisma.invoiceEmailSend.update({
          where: { id: input.sendId },
          data: {
            status: "sent",
            messageId: input.messageId,
            error: null,
            finishedAt: new Date(),
          },
        }),
        prisma.salesInvoice.update({ where: { id: input.invoiceId }, data: invoiceData }),
        ...(input.wasDraft
          ? [
              prisma.invoiceActivity.create({
                data: {
                  invoiceId: input.invoiceId,
                  kind: "sent",
                  summary: "Lasku lähetettiin sähköpostilla.",
                },
              }),
            ]
          : []),
      ]);
      return true;
    } catch (error) {
      if (attempt === 2) {
        console.error("Invoice mail was accepted but the outcome was not stored", error);
      }
    }
  }
  return false;
}

export interface SendInvoiceDeps {
  deliver?: (
    account: MailSenderAccount,
    mail: Parameters<typeof sendMail>[1]
  ) => Promise<SentMail>;
  persist?: typeof persistAcceptedMail;
}

/**
 * Sends the invoice and moves a draft to sent. Refusals happen before SMTP.
 * A failed send leaves a draft a draft and stores the failure. A send the
 * server accepted is not reported as a failure, even if the follow-up write fails.
 */
export async function sendInvoiceByEmail(
  userId: string,
  invoiceId: string,
  input: SendInvoiceInput = {},
  deps: SendInvoiceDeps = {}
): Promise<SendInvoiceResult> {
  const invoice = await getInvoice(userId, invoiceId);
  if (invoice.status === "credited") {
    throw new AppError("Hyvitettyä laskua ei lähetetä.", "INVOICE_CREDITED", 409);
  }
  if (invoice.lines.length === 0) {
    throw new ValidationError("Tyhjää laskua ei voi lähettää.");
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

  const stored = await prisma.salesInvoice.findFirst({
    where: { id: invoiceId, userId },
    select: {
      issueDate: true,
      customerId: true,
      partySnapshot: true,
      status: true,
      documentKind: true,
      grossCents: true,
      number: true,
    },
  });
  if (!stored) throw new AppError("Laskua ei löytynyt.", "NOT_FOUND", 404);

  await assertPeriodOpen(userId, [stored.issueDate]);

  const partySnapshot =
    parsePartySnapshot(stored.partySnapshot) != null
      ? stored.partySnapshot!
      : await capturePartySnapshot(userId, stored.customerId);

  const data: InvoicePdfData = await buildInvoicePdfData(userId, invoiceId);
  // Prefer the snapshot we are about to store, so the attachment matches it
  // even when the invoice row is still a draft and the builder read live data.
  const frozen = parsePartySnapshot(partySnapshot);
  if (frozen) {
    data.seller = frozen.seller;
    data.customer = frozen.customer;
  }
  const missing = missingSellerSendFields(data.seller);
  if (missing.length > 0) {
    throw new AppError(
      "Lähettäjän nimi tai tilinumero puuttuu. Täydennä yrityksen tiedot ennen lähetystä.",
      "SELLER_INCOMPLETE",
      409
    );
  }
  const pdf = await renderInvoicePdf(data);
  const creditNote = stored.documentKind === "credit_note";
  const attachment = invoicePdfFileName(invoice.number, creditNote ? "credit_note" : "invoice");
  const subject =
    input.subject ??
    `${creditNote ? "Hyvityslasku" : "Lasku"} ${invoice.number} · ${data.seller.name}`;
  const text =
    input.message ??
    defaultMessage({
      number: invoice.number,
      gross: formatEur(invoice.gross),
      dueDate: invoice.dueDate,
      reference: formatReference(invoice.reference),
      sellerName: data.seller.name,
      creditNote,
    });

  const attempt = await prisma.invoiceEmailSend.create({
    data: {
      invoiceId,
      toAddress: to,
      subject,
      status: "pending",
      partySnapshot,
      attachmentName: attachment,
      grossCents: stored.grossCents,
    },
  });

  const deliver = deps.deliver ?? sendMail;
  let sent: SentMail;
  try {
    sent = await deliver(account, {
      to,
      subject,
      text,
      attachments: [
        {
          filename: attachment,
          content: pdf,
          contentType: "application/pdf",
        },
      ],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "tuntematon virhe";
    await prisma.invoiceEmailSend
      .update({
        where: { id: attempt.id },
        data: { status: "failed", error: message.slice(0, 500), finishedAt: new Date() },
      })
      .catch(() => undefined);
    throw error;
  }

  const recorded = await (deps.persist ?? persistAcceptedMail)({
    sendId: attempt.id,
    invoiceId,
    messageId: sent.messageId,
    wasDraft: invoice.status === "draft",
    partySnapshot,
  });

  return {
    sentTo: sent.to,
    messageId: sent.messageId,
    invoiceNumber: invoice.number,
    attachment,
    statusChanged: recorded && invoice.status === "draft",
    recorded,
    notice: recorded ? null : UNRECORDED_NOTICE,
  };
}

export interface SendPreview {
  recipient: string | null;
  gross: number;
  dueDate: string;
  iban: string | null;
  attachment: string;
  missing: string[];
  blockedReason: string | null;
}

/** What the sender confirms before SMTP. Does not send. */
export async function previewInvoiceSend(userId: string, invoiceId: string): Promise<SendPreview> {
  const invoice = await getInvoice(userId, invoiceId);
  const stored = await prisma.salesInvoice.findFirst({
    where: { id: invoiceId, userId },
    select: { partySnapshot: true, customerId: true, documentKind: true },
  });
  if (!stored) throw new AppError("Laskua ei löytynyt.", "NOT_FOUND", 404);

  const partySnapshot =
    parsePartySnapshot(stored.partySnapshot) != null
      ? stored.partySnapshot!
      : await capturePartySnapshot(userId, stored.customerId);
  const data = await buildInvoicePdfData(userId, invoiceId);
  const frozen = parsePartySnapshot(partySnapshot);
  if (frozen) {
    data.seller = frozen.seller;
    data.customer = frozen.customer;
  }
  const missing = missingSellerSendFields(data.seller);
  const creditNote = stored.documentKind === "credit_note";
  let blockedReason: string | null = null;
  if (invoice.status === "credited") {
    blockedReason = "Hyvitettyä laskua ei lähetetä.";
  } else if (missing.length > 0) {
    blockedReason =
      "Lähettäjän nimi tai tilinumero puuttuu. Täydennä yrityksen tiedot ennen lähetystä.";
  } else if (!invoice.customer.email) {
    blockedReason = "Vastaanottaja puuttuu.";
  }

  return {
    recipient: invoice.customer.email,
    gross: invoice.gross,
    dueDate: invoice.dueDate,
    iban: data.seller.iban ?? null,
    attachment: invoicePdfFileName(invoice.number, creditNote ? "credit_note" : "invoice"),
    missing,
    blockedReason,
  };
}
