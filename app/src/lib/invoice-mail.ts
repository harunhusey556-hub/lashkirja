/**
 * Emailing a sales invoice. Shared by the manual "send" action and by
 * automatic sending from a recurring schedule, so both compose the same
 * message and enforce the same preconditions.
 *
 * Period lock and the other refusals run before SMTP. The attempt is stored
 * first. After the server accepts the message, the outcome is written again.
 * If that write fails, the caller still reports that the mail left.
 */
import { createHash, randomUUID } from "crypto";
import { AppError, ValidationError } from "./api-errors";
import { formatDate, formatEur, formatMonth } from "./format";
import { formatIban } from "./iban";
import { formatReference } from "./finnish-reference";
import { renderInvoicePdf, type InvoicePdfData } from "./invoice-pdf";
import { missingSellerSendFields, parsePartySnapshot } from "./invoice-snapshot";
import { findSenderAccount, sendMail, type MailSenderAccount, type SentMail } from "./mailer";
import { assertPeriodOpen, getLockedThrough, isDateLocked } from "./period-lock";
import { monthKey } from "./bank-balances";
import {
  assertDraftVatCurrent,
  buildInvoicePdfData,
  capturePartySnapshot,
  getInvoice,
  invoicePdfFileName,
  SEND_ATTEMPT_STALE_MS,
} from "./sales-invoices";
import { prisma } from "./db";
import { CRASHED_SEND_NOTE } from "./send-history";
import {
  cleanMessage,
  cleanSubject,
  defaultEmailTemplate,
  getEmailTemplate,
  listEmailTemplates,
  renderPlaceholders,
  type PlaceholderValues,
} from "./invoice-email-templates";

export interface SendInvoiceInput {
  to?: string;
  /** The owner's own text; placeholders in it are filled like a template's. */
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

export function defaultMessage(data: {
  number: number;
  gross: string;
  dueDate: string;
  reference: string;
  sellerName: string;
  creditNote?: boolean;
}): string {
  // A credit note is not payable: no due date, no reference to pay against.
  const payment = data.creditNote
    ? [`Summa: ${data.gross}`, "Tämä on hyvityslasku, ei maksettava lasku."]
    : [`Summa: ${data.gross}`, `Eräpäivä: ${data.dueDate}`, `Viitenumero: ${data.reference}`];
  return [
    "Hei,",
    "",
    data.creditNote ? `liitteenä hyvityslasku ${data.number}.` : `liitteenä lasku ${data.number}.`,
    "",
    ...payment,
    "",
    "Kiitos!",
    data.sellerName,
  ].join("\n");
}

export function defaultSubject(data: { number: number; sellerName: string; creditNote?: boolean }): string {
  return `${data.creditNote ? "Hyvityslasku" : "Lasku"} ${data.number} · ${data.sellerName}`;
}

/** What one invoice puts in the place of each placeholder. A credit note has nothing to pay against. */
export function invoicePlaceholderValues(data: {
  number: number;
  gross: number;
  dueDate: string;
  reference: string;
  iban: string | null | undefined;
  sellerName: string;
  customerName: string;
  creditNote: boolean;
}): PlaceholderValues {
  return {
    asiakas: data.customerName,
    laskunumero: String(data.number),
    summa: formatEur(data.gross),
    erapaiva: data.creditNote ? "–" : formatDate(data.dueDate),
    viitenumero: data.creditNote ? "–" : formatReference(data.reference),
    tilinumero: data.iban ? formatIban(data.iban) : "–",
    yritys: data.sellerName,
  };
}

export interface ComposedInvoiceMail {
  subject: string;
  message: string;
  /** The template the text came from; null for the owner's own text or the built-in one. */
  templateId: string | null;
}

/**
 * The subject and message for one invoice: the owner's own text when given,
 * else the chosen template, else the default template, else the built-in text.
 * Placeholders are filled in every case.
 */
export async function composeInvoiceMail(
  userId: string,
  values: PlaceholderValues,
  builtIn: { subject: string; message: string },
  input: { subject?: string; message?: string; templateId?: string } = {}
): Promise<ComposedInvoiceMail> {
  const template = input.templateId
    ? await getEmailTemplate(userId, input.templateId)
    : input.subject !== undefined && input.message !== undefined
      ? null
      : await defaultEmailTemplate(userId, "invoice");
  const subject = input.subject ?? template?.subject ?? builtIn.subject;
  const message = input.message ?? template?.body ?? builtIn.message;
  return {
    // Cleaned again after filling: a customer name cannot add a line break to the subject.
    subject: cleanSubject(renderPlaceholders(subject, values)),
    message: cleanMessage(renderPlaceholders(message, values)),
    templateId: input.subject === undefined && input.message === undefined ? (template?.id ?? null) : null,
  };
}

const UNRECORDED_NOTICE =
  "Viesti lähti, mutta lähetyksen kirjausta ei saatu tallennettua. Älä lähetä samaa laskua uudelleen ennen tarkistusta.";

const SEND_LOCK_STALE_MS = 2 * 60 * 1000;
const AMBIGUOUS_SEND =
  "Edellinen lähetys jäi epäselväksi. Älä lähetä samaa laskua uudelleen ennen tarkistusta.";
const SEND_IN_PROGRESS = "Laskua lähetetään juuri nyt. Odota hetki.";

async function claimSendLock(userId: string, invoiceId: string): Promise<string> {
  const token = randomUUID();
  const claimed = await prisma.salesInvoice.updateMany({
    where: { id: invoiceId, userId, sendLockToken: null },
    data: { sendLockToken: token, sendLockAt: new Date() },
  });
  if (claimed.count === 1) return token;

  const row = await prisma.salesInvoice.findFirst({
    where: { id: invoiceId, userId },
    select: { sendLockToken: true, sendLockAt: true },
  });
  if (!row) throw new AppError("Laskua ei löytynyt.", "NOT_FOUND", 404);

  // An attempt that has sat in pending/sending for longer than a live send can
  // take belongs to a process that died. It is closed as failed, so it stops
  // blocking this invoice for good; the lock it left behind is reclaimed below.
  await prisma.invoiceEmailSend.updateMany({
    where: {
      invoiceId,
      status: { in: ["pending", "sending"] },
      createdAt: { lt: new Date(Date.now() - SEND_ATTEMPT_STALE_MS) },
    },
    data: { status: "failed", error: CRASHED_SEND_NOTE, finishedAt: new Date() },
  });

  const open = await prisma.invoiceEmailSend.findFirst({
    where: { invoiceId, status: { in: ["sending", "ambiguous"] } },
    select: { status: true },
  });
  if (open?.status === "ambiguous") {
    throw new AppError(AMBIGUOUS_SEND, "SEND_AMBIGUOUS", 409);
  }
  // Still within the time a live send can take: it is in progress, not lost.
  if (open) throw new AppError(SEND_IN_PROGRESS, "SEND_IN_PROGRESS", 409);

  const stale = Boolean(row.sendLockAt && Date.now() - row.sendLockAt.getTime() > SEND_LOCK_STALE_MS);
  if (stale && row.sendLockToken) {
    const reclaimed = await prisma.salesInvoice.updateMany({
      where: { id: invoiceId, userId, sendLockToken: row.sendLockToken },
      data: { sendLockToken: token, sendLockAt: new Date() },
    });
    if (reclaimed.count === 1) return token;
  }

  throw new AppError(SEND_IN_PROGRESS, "SEND_IN_PROGRESS", 409);
}

async function releaseSendLock(invoiceId: string, token: string): Promise<void> {
  await prisma.salesInvoice.updateMany({
    where: { id: invoiceId, sendLockToken: token },
    data: { sendLockToken: null, sendLockAt: null },
  });
}

async function persistAcceptedMail(input: {
  sendId: string;
  invoiceId: string;
  messageId: string;
  wasDraft: boolean;
  partySnapshot: string;
  lockToken: string;
  contentHash: string;
  documentSnapshot: string;
}): Promise<boolean> {
  const invoiceData: Record<string, unknown> = {
    partySnapshot: input.partySnapshot,
    sendLockToken: null,
    sendLockAt: null,
    sentContentHash: input.contentHash,
    sentDocumentSnapshot: input.documentSnapshot,
  };
  if (input.wasDraft) {
    invoiceData.status = "sent";
    invoiceData.sentAt = new Date();
    invoiceData.paidAt = null;
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await prisma.$transaction(async (tx) => {
        const locked = await tx.salesInvoice.updateMany({
          where: { id: input.invoiceId, sendLockToken: input.lockToken },
          data: invoiceData,
        });
        if (locked.count !== 1) throw new Error("send lock lost");
        await tx.invoiceEmailSend.update({
          where: { id: input.sendId },
          data: {
            status: "sent",
            messageId: input.messageId,
            error: null,
            finishedAt: new Date(),
            contentHash: input.contentHash,
            documentSnapshot: input.documentSnapshot,
          },
        });
        if (input.wasDraft) {
          await tx.invoiceActivity.create({
            data: {
              invoiceId: input.invoiceId,
              kind: "sent",
              summary: "Lasku lähetettiin sähköpostilla.",
            },
          });
        }
      });
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
  if (invoice.status === "draft") await assertDraftVatCurrent(userId, invoiceId);

  const to =input.to ?? invoice.customer.email;
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

  const early = await prisma.salesInvoice.findFirst({
    where: { id: invoiceId, userId },
    select: { issueDate: true },
  });
  if (!early) throw new AppError("Laskua ei löytynyt.", "NOT_FOUND", 404);
  await assertPeriodOpen(userId, [early.issueDate]);

  const lockToken = await claimSendLock(userId, invoiceId);
  let attemptId: string | null = null;
  let frozenInvoice = invoice;
  let attachment = "";
  let contentHash = "";
  let documentSnapshot = "";
  let partySnapshot = "";
  try {
    frozenInvoice = await getInvoice(userId, invoiceId);
    const stored = await prisma.salesInvoice.findFirst({
      where: { id: invoiceId, userId },
      select: {
        customerId: true,
        partySnapshot: true,
        documentKind: true,
        grossCents: true,
        number: true,
        lines: { orderBy: { sortOrder: "asc" } },
      },
    });
    if (!stored) throw new AppError("Laskua ei löytynyt.", "NOT_FOUND", 404);

    partySnapshot =
      parsePartySnapshot(stored.partySnapshot) != null
        ? stored.partySnapshot!
        : await capturePartySnapshot(userId, stored.customerId);

    const data: InvoicePdfData = await buildInvoicePdfData(userId, invoiceId);
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
    contentHash = createHash("sha256").update(pdf).digest("hex");
    documentSnapshot = JSON.stringify({
      number: stored.number,
      grossCents: stored.grossCents,
      partySnapshot,
      lines: stored.lines.map((line) => ({
        description: line.description,
        quantityMilli: line.quantityMilli,
        unitPriceCents: line.unitPriceCents,
        vatRatePermille: line.vatRatePermille,
        netCents: line.netCents,
      })),
    });
    const creditNote = stored.documentKind === "credit_note";
    attachment = invoicePdfFileName(frozenInvoice.number, creditNote ? "credit_note" : "invoice");
    const { subject, message: text } = await composeInvoiceMail(
      userId,
      invoicePlaceholderValues({
        number: frozenInvoice.number,
        gross: frozenInvoice.gross,
        dueDate: frozenInvoice.dueDate,
        reference: frozenInvoice.reference,
        iban: data.seller.iban,
        sellerName: data.seller.name,
        customerName: data.customer.name,
        creditNote,
      }),
      builtInMail(frozenInvoice, data.seller.name, creditNote),
      { subject: input.subject, message: input.message }
    );

    const attempt = await prisma.invoiceEmailSend.create({
      data: {
        invoiceId,
        toAddress: to,
        subject,
        status: "pending",
        partySnapshot,
        attachmentName: attachment,
        grossCents: stored.grossCents,
        contentHash,
        documentSnapshot,
      },
    });
    attemptId = attempt.id;

    await prisma.invoiceEmailSend.update({
      where: { id: attempt.id },
      data: { status: "sending" },
    });

    const deliver = deps.deliver ?? sendMail;
    let sent: SentMail;
    try {
      sent = await deliver(account, {
        to,
        subject,
        text,
        attachments: [{ filename: attachment, content: pdf, contentType: "application/pdf" }],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "tuntematon virhe";
      await prisma.invoiceEmailSend
        .update({
          where: { id: attempt.id },
          data: { status: "failed", error: message.slice(0, 500), finishedAt: new Date() },
        })
        .catch(() => undefined);
      await releaseSendLock(invoiceId, lockToken);
      throw error;
    }

    let recorded = false;
    try {
      recorded = await (deps.persist ?? persistAcceptedMail)({
        sendId: attempt.id,
        invoiceId,
        messageId: sent.messageId,
        wasDraft: frozenInvoice.status === "draft",
        partySnapshot,
        lockToken,
        contentHash,
        documentSnapshot,
      });
    } catch (error) {
      console.error("Invoice mail was accepted but the outcome was not stored", error);
      recorded = false;
    }
    if (!recorded) {
      await prisma.invoiceEmailSend
        .update({ where: { id: attempt.id }, data: { status: "ambiguous" } })
        .catch(() => undefined);
    }

    return {
      sentTo: sent.to,
      messageId: sent.messageId,
      invoiceNumber: frozenInvoice.number,
      attachment,
      statusChanged: recorded && frozenInvoice.status === "draft",
      recorded,
      notice: recorded ? null : UNRECORDED_NOTICE,
    };
  } catch (error) {
    if (attemptId) {
      const row = await prisma.invoiceEmailSend.findUnique({
        where: { id: attemptId },
        select: { status: true },
      });
      if (row && (row.status === "pending" || row.status === "sending")) {
        await prisma.invoiceEmailSend
          .update({
            where: { id: attemptId },
            data: {
              status: "failed",
              error: error instanceof Error ? error.message.slice(0, 500) : "tuntematon virhe",
              finishedAt: new Date(),
            },
          })
          .catch(() => undefined);
        await releaseSendLock(invoiceId, lockToken);
      }
    } else {
      await releaseSendLock(invoiceId, lockToken);
    }
    throw error;
  }
}

function builtInMail(
  invoice: { number: number; gross: number; dueDate: string; reference: string },
  sellerName: string,
  creditNote: boolean
): { subject: string; message: string } {
  return {
    subject: defaultSubject({ number: invoice.number, sellerName, creditNote }),
    message: defaultMessage({
      number: invoice.number,
      gross: formatEur(invoice.gross),
      dueDate: formatDate(invoice.dueDate),
      reference: formatReference(invoice.reference),
      sellerName,
      creditNote,
    }),
  };
}

export interface SendPreview {
  recipient: string | null;
  gross: number;
  /** Null for a credit note: it has no due date. */
  dueDate: string | null;
  /** Null for a credit note: nothing to pay. */
  iban: string | null;
  creditNote: boolean;
  attachment: string;
  missing: string[];
  blockedReason: string | null;
  /** True when no sending mailbox is connected: a send would be refused (F41). */
  mailboxMissing: boolean;
  /** The month key ("2026-08") of the issue date when that month is closed; a send would be refused (G09). */
  lockedMonth: string | null;
  /** The text a send without one of its own would carry, ready to edit (default template or built-in). */
  subject: string;
  message: string;
  /** The template `subject`/`message` came from; null for the built-in text. */
  templateId: string | null;
  /** The owner's invoice templates for the picker, the default first. */
  templates: Array<{ id: string; name: string; isDefault: boolean }>;
  /** What each placeholder stands for on this invoice, so a client can turn the values back into placeholders. */
  placeholders: PlaceholderValues;
}

/** What the sender confirms before SMTP. Does not send. */
export async function previewInvoiceSend(
  userId: string,
  invoiceId: string,
  options: { templateId?: string } = {}
): Promise<SendPreview> {
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
  // The same two gates sendInvoiceByEmail applies, told before the tap.
  const mailboxMissing = (await findSenderAccount(userId)) === null;
  const lockedThrough = await getLockedThrough(userId);
  const lockedMonth = isDateLocked(lockedThrough, invoice.issueDate) ? monthKey(invoice.issueDate) : null;
  let blockedReason: string | null = null;
  if (invoice.status === "credited") {
    blockedReason = "Hyvitettyä laskua ei lähetetä.";
  } else if (missing.length > 0) {
    blockedReason =
      "Lähettäjän nimi tai tilinumero puuttuu. Täydennä yrityksen tiedot ennen lähetystä.";
  } else if (!invoice.customer.email) {
    blockedReason = "Vastaanottaja puuttuu.";
  } else if (mailboxMissing) {
    blockedReason = "Sähköpostitiliä ei ole yhdistetty.";
  } else if (lockedMonth) {
    blockedReason = `Kausi ${formatMonth(lockedMonth)} on suljettu.`;
  }

  const placeholders = invoicePlaceholderValues({
    number: invoice.number,
    gross: invoice.gross,
    dueDate: invoice.dueDate,
    reference: invoice.reference,
    iban: data.seller.iban,
    sellerName: data.seller.name,
    customerName: data.customer.name,
    creditNote,
  });
  const composed = await composeInvoiceMail(
    userId,
    placeholders,
    builtInMail(invoice, data.seller.name, creditNote),
    { templateId: options.templateId }
  );
  const templates = (await listEmailTemplates(userId, "invoice")).map((t) => ({
    id: t.id,
    name: t.name,
    isDefault: t.isDefault,
  }));

  return {
    recipient: invoice.customer.email,
    gross: invoice.gross,
    dueDate: creditNote ? null : invoice.dueDate,
    iban: creditNote ? null : (data.seller.iban ?? null),
    creditNote,
    attachment: invoicePdfFileName(invoice.number, creditNote ? "credit_note" : "invoice"),
    missing,
    blockedReason,
    mailboxMissing,
    lockedMonth,
    subject: composed.subject,
    message: composed.message,
    templateId: composed.templateId,
    templates,
    placeholders,
  };
}
