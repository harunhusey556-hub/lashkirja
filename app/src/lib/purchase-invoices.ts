/**
 * Purchase invoices (ostolaskut): what the business owes and when.
 *
 * F39, the VAT rule: a recorded purchase invoice's VAT is deductible in the VAT
 * return (field 307) in the period of its invoice date, whether it is open or
 * paid; a cancelled one counts nothing. The return reads it through
 * lib/alv-period.ts, which counts one purchase once: an invoice linked to an
 * approved receipt (`receiptId`), or paid from a bank row that an approved
 * receipt documents, or matching a receipt on number, reference or supplier +
 * amount + date, is counted through the receipt and left out of the invoice
 * side. The one written rule is in alv-period.ts (`classifyPurchaseInvoices`).
 * The owner settles a flagged pair by linking the receipt here, never by
 * rejecting or cancelling.
 *
 * A supplier credit note (hyvityslasku) is a row of its own with a NEGATIVE
 * total (`grossCents < 0`), linked to the invoice it corrects by
 * `creditsInvoiceId`. It posts the mirror of an ostolasku through the same
 * ledger path (negative expense, negative input VAT, payables reduced) and
 * counts in the VAT return in the period of its own date. The corrected
 * invoice keeps its figures: what is still owed is gross - paid - credited.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "./db";
import { AppError, NotFoundError, ValidationError } from "./api-errors";
import { centsToEuros, eurosToCents, vatCentsInGrossCents } from "./money";
import { formatDate, formatEur } from "./format";
import { helsinkiCalendarDate, isoDateToUtc } from "./validation";
import { isValidBusinessId, isValidReferenceNumber, normalizeBusinessId, normalizeReference } from "./finnish-reference";
import { isValidIban, normalizeIban } from "./iban";
import { buildAging, creditedCentsOf, displayStatus, openPosition, overdueBefore, type AgingReport } from "./invoices";
import { assertPeriodOpen, PeriodLockedError } from "./period-lock";
import { planPairs } from "./match-gate";
import { rejectedPurchasePairs } from "./purchase-bank-match";
import { isPurchaseVatTreatment, type PurchaseVatTreatment } from "./alv";
import type { ExtractedReceipt } from "./ai";

export type PurchaseStatus = "open" | "paid" | "credited" | "cancelled";

export interface PurchaseInvoiceInput {
  supplierName: string;
  supplierBusinessId?: string | null;
  supplierIban?: string | null;
  invoiceNumber?: string | null;
  reference?: string | null;
  issueDate: string;
  dueDate: string;
  gross: number;
  vat?: number;
  category?: string | null;
  notes?: string | null;
  receiptId?: string | null;
  /** ISO 4217 of the invoice; gross and VAT stay in euros. */
  currency?: string;
  /** The amount in `currency` when it is not EUR. */
  originalAmount?: number | null;
  vatTreatment?: PurchaseVatTreatment;
  /** Set by a recurring purchase run (lib/recurring-purchases.ts), never by a client. */
  recurringPurchaseId?: string | null;
}

export interface PublicPurchaseInvoice {
  id: string;
  supplierName: string;
  supplierBusinessId: string | null;
  supplierIban: string | null;
  invoiceNumber: string | null;
  reference: string | null;
  issueDate: string;
  dueDate: string;
  status: PurchaseStatus;
  displayStatus: PurchaseStatus | "overdue";
  gross: number;
  vat: number;
  net: number;
  paid: number;
  /** Total of the credit notes against this invoice (positive). */
  credited: number;
  open: number;
  closedReason: string | null;
  category: string | null;
  notes: string | null;
  currency: string;
  originalAmount: number | null;
  vatTreatment: PurchaseVatTreatment;
  paidAt: string | null;
  receiptId: string | null;
  /** The recurring template that created this invoice ("Toistuva"), if any. */
  recurringPurchaseId: string | null;
  /** True for a supplier credit note (a negative total); it is never a payable. */
  isCreditNote: boolean;
  /** The invoice a credit note corrects; null on invoices and on a credit note filed on its own. */
  creditsInvoiceId: string | null;
  /** Credit notes against this invoice, oldest first (amounts negative, as stored). */
  creditNotes: Array<{ id: string; issueDate: string; gross: number; invoiceNumber: string | null }>;
  payments: Array<{
    id: string;
    paidDate: string;
    amount: number;
    source: string;
    transactionId: string | null;
    note: string | null;
    /** The bank row that paid it ("Irrota" frees the row), when one did. */
    transaction: {
      id: string;
      statementId: string;
      date: string | null;
      counterparty: string | null;
      /** Signed, as on the bank statement: a payment out is negative. */
      amount: number;
    } | null;
  }>;
}

type PurchaseRow = {
  id: string;
  supplierName: string;
  supplierBusinessId: string | null;
  supplierIban: string | null;
  invoiceNumber: string | null;
  reference: string | null;
  issueDate: Date;
  dueDate: Date;
  status: string;
  grossCents: number;
  vatCents: number;
  netCents: number;
  category: string | null;
  notes: string | null;
  currency: string;
  originalAmountCents: number | null;
  vatTreatment: string;
  paidAt: Date | null;
  closedReason: string | null;
  receiptId: string | null;
  recurringPurchaseId: string | null;
  creditsInvoiceId: string | null;
  creditNotes: Array<{
    id: string;
    issueDate: Date;
    grossCents: number;
    invoiceNumber: string | null;
    status: string;
  }>;
  payments: Array<{
    id: string;
    paidDate: Date;
    amountCents: number;
    source: string;
    transactionId: string | null;
    note: string | null;
    transaction?: {
      id: string;
      statementId: string;
      date: Date | null;
      counterparty: string | null;
      amountCents: number;
    } | null;
  }>;
};

const purchaseInclude = {
  creditNotes: { // wave2-schema: PurchaseInvoice.creditsInvoiceId / creditNotes
    select: { id: true, issueDate: true, grossCents: true, invoiceNumber: true, status: true },
    orderBy: { issueDate: "asc" as const },
  },
  payments: {
    orderBy: { paidDate: "asc" as const },
    include: {
      transaction: {
        select: { id: true, statementId: true, date: true, counterparty: true, amountCents: true },
      },
    },
  },
};

export function toPublicPurchaseInvoice(
  invoice: PurchaseRow,
  now: Date = new Date()
): PublicPurchaseInvoice {
  const paidCents = invoice.payments.reduce((sum, payment) => sum + payment.amountCents, 0);
  const isCreditNote = invoice.grossCents < 0;
  const creditedCents = creditedCentsOf(invoice.creditNotes);
  const position = openPosition({
    status: invoice.status,
    grossCents: invoice.grossCents,
    paidCents,
    creditedCents,
    closedReason: invoice.closedReason,
  });
  // An open payable ages exactly like an unpaid sales invoice. A credit note
  // is nothing to pay: it lists with the credited invoices.
  const derived = isCreditNote
    ? invoice.status === "cancelled"
      ? "cancelled"
      : "credited"
    : invoice.status === "open"
      ? displayStatus({ status: "sent", dueDate: invoice.dueDate }, now) === "overdue"
        ? "overdue"
        : "open"
      : (invoice.status as PurchaseStatus);

  return {
    id: invoice.id,
    supplierName: invoice.supplierName,
    supplierBusinessId: invoice.supplierBusinessId,
    supplierIban: invoice.supplierIban,
    invoiceNumber: invoice.invoiceNumber,
    reference: invoice.reference,
    issueDate: invoice.issueDate.toISOString().slice(0, 10),
    dueDate: invoice.dueDate.toISOString().slice(0, 10),
    status: invoice.status as PurchaseStatus,
    displayStatus: derived,
    gross: centsToEuros(invoice.grossCents),
    vat: centsToEuros(invoice.vatCents),
    net: centsToEuros(invoice.netCents),
    paid: centsToEuros(paidCents),
    credited: centsToEuros(creditedCents),
    open: isCreditNote ? 0 : centsToEuros(position.openCents),
    closedReason: invoice.closedReason,
    category: invoice.category,
    notes: invoice.notes,
    currency: invoice.currency,
    originalAmount: invoice.originalAmountCents == null ? null : centsToEuros(invoice.originalAmountCents),
    vatTreatment: isPurchaseVatTreatment(invoice.vatTreatment) ? invoice.vatTreatment : "domestic",
    paidAt: invoice.paidAt ? invoice.paidAt.toISOString() : null,
    receiptId: invoice.receiptId,
    recurringPurchaseId: invoice.recurringPurchaseId,
    isCreditNote,
    creditsInvoiceId: invoice.creditsInvoiceId, // wave2-schema: PurchaseInvoice.creditsInvoiceId / creditNotes
    creditNotes: invoice.creditNotes
      .filter((note) => note.status !== "cancelled")
      .map((note) => ({
        id: note.id,
        issueDate: note.issueDate.toISOString().slice(0, 10),
        gross: centsToEuros(note.grossCents),
        invoiceNumber: note.invoiceNumber,
      })),
    payments: invoice.payments.map((payment) => ({
      id: payment.id,
      paidDate: payment.paidDate.toISOString().slice(0, 10),
      amount: centsToEuros(payment.amountCents),
      source: payment.source,
      transactionId: payment.transactionId,
      note: payment.note,
      transaction: payment.transaction
        ? {
            id: payment.transaction.id,
            statementId: payment.transaction.statementId,
            date: payment.transaction.date ? payment.transaction.date.toISOString().slice(0, 10) : null,
            counterparty: payment.transaction.counterparty,
            amount: centsToEuros(payment.transaction.amountCents),
          }
        : null,
    })),
  };
}

/** A supplier's viitenumero, normalized; refused when its check digit is wrong. */
export function prepareReference(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = normalizeReference(value);
  if (!normalized) return null;
  if (!isValidReferenceNumber(normalized)) {
    throw new ValidationError("Viitenumero ei ole kelvollinen (tarkistusnumero ei täsmää).");
  }
  return normalized;
}

/**
 * A viite read from a document, or null: the reading is a guess, so a check digit
 * that does not hold drops the viite instead of refusing the bill (W27).
 */
export function readReference(value: string | null | undefined): string | null {
  const normalized = value ? normalizeReference(value) : "";
  return normalized && isValidReferenceNumber(normalized) ? normalized : null;
}

/** The supplier's Y-tunnus and IBAN, normalized; refused when either is not valid. */
export function prepareSupplier(input: Pick<PurchaseInvoiceInput, "supplierBusinessId" | "supplierIban">) {
  let businessId: string | null = null;
  if (input.supplierBusinessId?.trim()) {
    if (!isValidBusinessId(input.supplierBusinessId)) {
      throw new ValidationError("Toimittajan Y-tunnus ei ole kelvollinen.");
    }
    businessId = normalizeBusinessId(input.supplierBusinessId);
  }

  let iban: string | null = null;
  if (input.supplierIban?.trim()) {
    const normalized = normalizeIban(input.supplierIban);
    if (!isValidIban(normalized)) {
      throw new ValidationError("Toimittajan IBAN ei ole kelvollinen.");
    }
    iban = normalized;
  }

  return { businessId, iban };
}

/** Gross, VAT and net in cents; net is what the gross leaves after VAT. */
export function purchaseAmounts(gross: number, vat: number | undefined) {
  const grossCents = eurosToCents(gross);
  if (grossCents <= 0) throw new ValidationError("Laskun summan on oltava positiivinen.");
  const vatCents = vat === undefined ? 0 : eurosToCents(vat);
  if (vatCents < 0) throw new ValidationError("ALV ei voi olla negatiivinen.");
  if (vatCents > grossCents) {
    throw new ValidationError("ALV ei voi olla suurempi kuin laskun loppusumma.");
  }
  return { grossCents, vatCents, netCents: grossCents - vatCents };
}

/**
 * The same amounts when only the gross and the VAT rate are known: the VAT
 * inside the gross, rounded to the cent, exactly as the purchase form derives it.
 */
export function purchaseAmountsFromRate(gross: number, vatRate: number) {
  const grossCents = eurosToCents(gross);
  if (grossCents <= 0) throw new ValidationError("Laskun summan on oltava positiivinen.");
  return purchaseAmounts(gross, centsToEuros(vatCentsInGrossCents(grossCents, vatRate)));
}

async function assertReceiptAvailable(
  userId: string,
  receiptId: string,
  exceptInvoiceId?: string,
  db: Prisma.TransactionClient | typeof prisma = prisma
): Promise<void> {
  const receipt = await db.receipt.findFirst({
    where: { id: receiptId, userId },
    select: { id: true },
  });
  if (!receipt) throw new NotFoundError("Kuittia ei löytynyt.");
  const taken = await db.purchaseInvoice.findFirst({
    where: { receiptId, ...(exceptInvoiceId ? { id: { not: exceptInvoiceId } } : {}) },
    select: { id: true },
  });
  if (taken) {
    throw new AppError("Kuitti on jo liitetty toiseen ostolaskuun.", "RECEIPT_IN_USE", 409);
  }
}

/**
 * The supplier's invoice number names one invoice: the same one entered twice doubled its cost
 * and its payable (audit 2026-10-09). An invoice without a number is not checked. A credit note
 * has a number of its own and is held to the same rule.
 */
async function assertInvoiceNumberFree(
  userId: string,
  supplierName: string,
  rawNumber: string | null | undefined,
  db: Prisma.TransactionClient | typeof prisma
): Promise<void> {
  const invoiceNumber = rawNumber?.trim() || null;
  if (!invoiceNumber) return;
  const sameNumber = await db.purchaseInvoice.findMany({
    where: { userId, invoiceNumber },
    select: { supplierName: true },
  });
  const key = supplierName.toLocaleLowerCase("fi");
  if (sameNumber.some((other) => other.supplierName.trim().toLocaleLowerCase("fi") === key)) {
    throw new AppError(`Lasku ${invoiceNumber} toimittajalta ${supplierName} on jo kirjattu.`, "DUPLICATE_PURCHASE_INVOICE", 409);
  }
}

/**
 * `db` is the transaction of an idempotent request (lib/idempotency.ts): every
 * read and write then goes through it, so SQLite never waits on itself.
 */
export async function createPurchaseInvoice(
  userId: string,
  input: PurchaseInvoiceInput,
  db?: Prisma.TransactionClient
): Promise<PublicPurchaseInvoice> {
  const supplierName = input.supplierName.trim();
  if (!supplierName) throw new ValidationError("Toimittajan nimi puuttuu.");

  const issueDate = isoDateToUtc(input.issueDate);
  const dueDate = isoDateToUtc(input.dueDate);
  if (dueDate.getTime() < issueDate.getTime()) {
    throw new ValidationError("Eräpäivä ei voi olla ennen laskun päivää.");
  }

  await assertPeriodOpen(userId, [issueDate], db ?? prisma);

  const { businessId, iban } = prepareSupplier(input);
  const { grossCents, vatCents, netCents } = purchaseAmounts(input.gross, input.vat);
  if (input.receiptId) await assertReceiptAvailable(userId, input.receiptId, undefined, db ?? prisma);

  await assertInvoiceNumberFree(userId, supplierName, input.invoiceNumber, db ?? prisma);

  const created = await (db ?? prisma).purchaseInvoice.create({
    data: {
      userId,
      supplierName,
      supplierBusinessId: businessId,
      supplierIban: iban,
      invoiceNumber: input.invoiceNumber?.trim() || null,
      reference: prepareReference(input.reference),
      issueDate,
      dueDate,
      grossCents,
      vatCents,
      netCents,
      category: input.category?.trim() || null,
      notes: input.notes?.trim() || null,
      receiptId: input.receiptId ?? null,
      recurringPurchaseId: input.recurringPurchaseId ?? null,
      currency: input.currency ?? "EUR",
      originalAmountCents: input.originalAmount == null ? null : eurosToCents(input.originalAmount),
      vatTreatment: input.vatTreatment ?? "domestic",
    },
    include: purchaseInclude,
  });
  return toPublicPurchaseInvoice(created);
}

/** The usual Finnish payment term when a bill does not print its own due date. */
export const DEFAULT_PAYMENT_TERM_DAYS = 14;
const ASSUMED_DUE_DATE_NOTE = `Eräpäivä on oletus: laskun päivä + ${DEFAULT_PAYMENT_TERM_DAYS} pv. Tarkista laskulta.`;

/** `issueDate` (YYYY-MM-DD) plus the default payment term. */
export function assumedDueDate(issueDate: string): string {
  const due = isoDateToUtc(issueDate);
  due.setUTCDate(due.getUTCDate() + DEFAULT_PAYMENT_TERM_DAYS);
  return due.toISOString().slice(0, 10);
}

export type ReceiptFilingSkip =
  | "not_an_invoice"
  | "sales_document"
  | "no_supplier"
  | "no_date"
  | "no_amount"
  | "duplicate"
  | "already_filed";

/**
 * Files a receipt the AI read as a payable bill ("lasku"): the receipt stays
 * the document - the VAT return keeps reading it, and a linked purchase
 * invoice is never counted twice - and the ostolasku tracks what is owed.
 * The same supplier invoice number is never entered twice (createPurchaseInvoice
 * guards that); a reading that is not a bill, or a receipt missing what an
 * invoice needs, files nothing. The caller reports what happened.
 *
 * Idempotent per receipt: every intake path (save, offline inbox, email, a
 * later edit) calls it, and a receipt that already has an ostolasku - open,
 * paid or cancelled by the owner - never gets a second one.
 */
export async function fileReceiptAsPurchaseInvoice(
  userId: string,
  receipt: {
    id: string;
    vendor: string | null;
    date: Date | null;
    invoiceNumber: string | null;
    /** The viite read from the bill: the bank row that carries it pays the ostolasku. */
    reference?: string | null;
    totalAmountCents: number | null;
    vatDetails: string | null;
    category: string | null;
    currency: string;
    originalAmountCents: number | null;
    vatTreatment: string;
    type: string;
    uploadId?: string | null;
    /** Read only to recognise a credit note (isCreditNoteExtraction). */
    notes?: string | null;
    rawText?: string | null;
    fileName?: string | null;
  },
  reading: Pick<ExtractedReceipt, "documentType" | "dueDate"> | null,
  db?: Prisma.TransactionClient
): Promise<
  | { created: true; invoice: PublicPurchaseInvoice }
  | { created: false; skipped: ReceiptFilingSkip }
> {
  if (isCreditNoteExtraction(receipt, reading)) return fileReceiptAsPurchaseCredit(userId, receipt, db);
  if (reading?.documentType !== "invoice") return { created: false, skipped: "not_an_invoice" };
  if (receipt.type === "tulo") return { created: false, skipped: "sales_document" };
  const client = db ?? prisma;
  const filed = await client.purchaseInvoice.findFirst({
    where: { userId, receiptId: receipt.id },
    select: { id: true },
  });
  if (filed) return { created: false, skipped: "already_filed" };
  const supplierName = receipt.vendor?.trim();
  if (!supplierName) return { created: false, skipped: "no_supplier" };
  if (!receipt.date) return { created: false, skipped: "no_date" };
  if (receipt.totalAmountCents == null || receipt.totalAmountCents <= 0) {
    return { created: false, skipped: "no_amount" };
  }
  const issueDate = receipt.date.toISOString().slice(0, 10);
  // A bill whose due date was not read gets the usual 14-day term, marked as an
  // assumption on the ostolasku and in the stored reading ("oletus"). A printed
  // due date before the issue date is a misreading and is treated the same.
  const readDue = reading.dueDate && reading.dueDate >= issueDate ? reading.dueDate : null;
  try {
    const invoice = await createPurchaseInvoice(
      userId,
      {
        supplierName,
        invoiceNumber: receipt.invoiceNumber,
        // Without it the payment carrying this viite never paid the bill (W27, owner's backup).
        reference: readReference(receipt.reference),
        issueDate,
        dueDate: readDue ?? assumedDueDate(issueDate),
        gross: centsToEuros(receipt.totalAmountCents),
        vat: receiptVatTotalEuros(receipt.vatDetails),
        category: receipt.category,
        notes: readDue ? null : ASSUMED_DUE_DATE_NOTE,
        receiptId: receipt.id,
        currency: receipt.currency,
        originalAmount:
          receipt.originalAmountCents == null ? null : centsToEuros(receipt.originalAmountCents),
        vatTreatment: isPurchaseVatTreatment(receipt.vatTreatment) ? receipt.vatTreatment : "domestic",
      },
      db
    );
    if (!readDue && receipt.uploadId) await markDueDateAssumed(client, userId, receipt.uploadId);
    return { created: true, invoice };
  } catch (error) {
    if (error instanceof AppError && error.code === "DUPLICATE_PURCHASE_INVOICE") {
      return { created: false, skipped: "duplicate" };
    }
    throw error;
  }
}

/** Writes `dueDateAssumed: true` into the upload's stored reading, so a screen can say "oletus". */
async function markDueDateAssumed(
  db: Prisma.TransactionClient | typeof prisma,
  userId: string,
  uploadId: string
): Promise<void> {
  const upload = await db.upload.findFirst({ where: { id: uploadId, userId }, select: { extractedJson: true } });
  if (!upload?.extractedJson) return;
  let reading: Record<string, unknown>;
  try {
    reading = JSON.parse(upload.extractedJson) as Record<string, unknown>;
  } catch (error) {
    // The flag is a display hint; the ostolasku's own note already says the date is assumed.
    console.warn(`Stored reading of upload ${uploadId} does not parse; due date not flagged:`, error);
    return;
  }
  await db.upload.update({
    where: { id: uploadId },
    data: { extractedJson: JSON.stringify({ ...reading, dueDateAssumed: true }) },
  });
}

function storedReading(extractedJson: string | null): {
  documentType: string | null;
  dueDate: string | null;
  dueDateAssumed: boolean;
} {
  if (!extractedJson) return { documentType: null, dueDate: null, dueDateAssumed: false };
  try {
    const read = JSON.parse(extractedJson) as { documentType?: string | null; dueDate?: string | null; dueDateAssumed?: boolean };
    return {
      documentType: read.documentType ?? null,
      dueDate: read.dueDate ?? null,
      dueDateAssumed: read.dueDateAssumed === true,
    };
  } catch {
    // A stored reading that does not parse says nothing about the kind.
    return { documentType: null, dueDate: null, dueDateAssumed: false };
  }
}

export interface ReceiptPurchaseInvoiceView {
  /** What the stored reading says the document is, when there is a reading. */
  documentType: string | null;
  purchaseInvoice: {
    id: string;
    status: PurchaseStatus;
    displayStatus: PurchaseStatus | "overdue";
    dueDate: string;
    /** The due date is still the 14-day default, not one printed on the bill. */
    dueDateAssumed: boolean;
  } | null;
}

/** The ostolasku a receipt is filed as, for the receipt screen's "Tämä on ostolasku" notice. */
export async function receiptPurchaseInvoiceView(
  userId: string,
  receiptId: string
): Promise<ReceiptPurchaseInvoiceView> {
  const receipt = await prisma.receipt.findFirst({
    where: { id: receiptId, userId },
    select: {
      upload: { select: { extractedJson: true } },
      purchaseInvoice: { include: purchaseInclude },
    },
  });
  if (!receipt) throw new NotFoundError("Kuittia ei löytynyt.");
  const reading = storedReading(receipt.upload?.extractedJson ?? null);
  const invoice = receipt.purchaseInvoice ? toPublicPurchaseInvoice(receipt.purchaseInvoice) : null;
  return {
    documentType: reading.documentType,
    purchaseInvoice: invoice
      ? {
          id: invoice.id,
          status: invoice.status,
          displayStatus: invoice.displayStatus,
          dueDate: invoice.dueDate,
          // Once the owner sets the real date on the ostolasku it is no longer an assumption.
          dueDateAssumed: reading.dueDateAssumed && invoice.dueDate === assumedDueDate(invoice.issueDate),
        }
      : null,
  };
}

const MARKED_AS_RECEIPT_REASON = "Merkitty kuitiksi";

/**
 * The owner says what a saved document is (PATCH /api/receipts/[id]).
 * "invoice" files the ostolasku, or reopens the one cancelled when it was
 * marked a kuitti; "receipt" cancels the open ostolasku - kept with its
 * history, never deleted. With no explicit kind, a receipt the reading calls a
 * bill is filed once it has what an ostolasku needs (an inbox capture the
 * owner completed by hand).
 */
export async function syncReceiptDocumentKind(
  userId: string,
  receiptId: string,
  kind: "invoice" | "receipt" | null
): Promise<{ action: "filed" | "reopened" | "cancelled" | "none"; skipped?: ReceiptFilingSkip }> {
  const receipt = await prisma.receipt.findFirst({
    where: { id: receiptId, userId },
    include: {
      upload: { select: { extractedJson: true } },
      purchaseInvoice: {
        select: { id: true, status: true, issueDate: true, closedReason: true, payments: { select: { id: true } } },
      },
    },
  });
  if (!receipt) throw new NotFoundError("Kuittia ei löytynyt.");
  const linked = receipt.purchaseInvoice;
  const reading = storedReading(receipt.upload?.extractedJson ?? null);

  if (kind === "receipt") {
    if (!linked || linked.status === "cancelled") return { action: "none" };
    if (linked.payments.length > 0) {
      throw new AppError(
        "Ostolaskulla on maksuja, joten sitä ei voi muuttaa kuitiksi. Poista maksut ensin.",
        "INVOICE_HAS_PAYMENTS",
        409
      );
    }
    await assertPeriodOpen(userId, [linked.issueDate]);
    await prisma.purchaseInvoice.update({
      where: { id: linked.id },
      data: { status: "cancelled", paidAt: null, closedReason: MARKED_AS_RECEIPT_REASON, closedAt: new Date() },
    });
    return { action: "cancelled" };
  }

  if (linked) {
    // Only the owner's own "kuitti" choice is undone by their "lasku" choice.
    if (kind === "invoice" && linked.status === "cancelled" && linked.closedReason === MARKED_AS_RECEIPT_REASON) {
      await assertPeriodOpen(userId, [linked.issueDate]);
      await prisma.purchaseInvoice.update({
        where: { id: linked.id },
        data: { status: "open", closedReason: null, closedAt: null },
      });
      return { action: "reopened" };
    }
    return { action: "none", skipped: "already_filed" };
  }

  if (kind !== "invoice" && reading.documentType !== "invoice") return { action: "none" };
  const filing = await fileReceiptAsPurchaseInvoice(userId, receipt, {
    documentType: "invoice",
    dueDate: reading.dueDate,
  });
  return filing.created ? { action: "filed" } : { action: "none", skipped: filing.skipped };
}

/**
 * The receipt's VAT lines added up, in EUROS - the unit `createPurchaseInvoice` takes
 * (`PurchaseInvoiceInput.vat`) and the unit the stored `vatDetails` JSON holds (the form's
 * `vatPayload` parses "12,34" into 12.34 euros, and the AI reads euro amounts too).
 *
 * This used to be called `receiptVatTotalCents` and its result was passed through
 * `centsToEuros()`, which threw `RangeError: Stored money value is not an integer number of
 * cents` for any bill whose VAT total was not a whole euro: the receipt was saved, the save
 * route answered 500, and no ostolasku was filed (found by the 2026-10-12 test group).
 */
function receiptVatTotalEuros(vatDetails: string | null): number {
  if (!vatDetails) return 0;
  try {
    const lines = JSON.parse(vatDetails) as Array<{ amount?: unknown }>;
    return Array.isArray(lines)
      ? lines.reduce(
          (sum, line) =>
            sum +
            (typeof line?.amount === "number" && Number.isFinite(line.amount) ? line.amount : 0),
          0
        )
      : 0;
  } catch {
    return 0;
  }
}

export async function updatePurchaseInvoice(
  userId: string,
  id: string,
  input: Partial<PurchaseInvoiceInput> & { status?: PurchaseStatus; closeReason?: string | null }
): Promise<PublicPurchaseInvoice> {
  const existing = await prisma.purchaseInvoice.findFirst({
    where: { id, userId },
    include: purchaseInclude,
  });
  if (!existing) throw new NotFoundError("Ostolaskua ei löytynyt.");
  await assertPeriodOpen(userId, [
    existing.issueDate,
    input.issueDate ? isoDateToUtc(input.issueDate) : null,
  ]);
  const isCreditNote = existing.grossCents < 0;
  if (isCreditNote) {
    // The amounts of a credit note are what the supplier credited; they are
    // not edited into a payable. A wrong one is removed and made again.
    if (input.gross !== undefined || input.vat !== undefined) {
      throw new AppError(
        "Hyvityslaskun summaa ei voi muuttaa. Poista hyvityslasku ja luo se uudelleen.",
        "CREDIT_NOTE_AMOUNT_LOCKED",
        409
      );
    }
    if (input.status !== undefined && input.status !== "paid" && input.status !== "cancelled") {
      throw new AppError("Hyvityslasku voidaan vain mitätöidä.", "CREDIT_NOTE_STATUS", 409);
    }
  }

  const data: Record<string, unknown> = {};
  if (input.supplierName !== undefined) {
    const name = input.supplierName.trim();
    if (!name) throw new ValidationError("Toimittajan nimi puuttuu.");
    data.supplierName = name;
  }
  if (input.supplierBusinessId !== undefined || input.supplierIban !== undefined) {
    const { businessId, iban } = prepareSupplier({
      supplierBusinessId:
        input.supplierBusinessId !== undefined
          ? input.supplierBusinessId
          : existing.supplierBusinessId,
      supplierIban:
        input.supplierIban !== undefined ? input.supplierIban : existing.supplierIban,
    });
    data.supplierBusinessId = businessId;
    data.supplierIban = iban;
  }
  if (input.invoiceNumber !== undefined) {
    data.invoiceNumber = input.invoiceNumber?.trim() || null;
  }
  if (input.reference !== undefined) data.reference = prepareReference(input.reference);
  if (input.category !== undefined) data.category = input.category?.trim() || null;
  if (input.notes !== undefined) data.notes = input.notes?.trim() || null;
  if (input.currency !== undefined) data.currency = input.currency;
  if (input.originalAmount !== undefined) {
    data.originalAmountCents = input.originalAmount == null ? null : eurosToCents(input.originalAmount);
  }
  if (input.vatTreatment !== undefined) data.vatTreatment = input.vatTreatment;

  const issueDate = input.issueDate ? isoDateToUtc(input.issueDate) : existing.issueDate;
  if (input.issueDate) data.issueDate = issueDate;
  if (input.dueDate) {
    const dueDate = isoDateToUtc(input.dueDate);
    if (dueDate.getTime() < issueDate.getTime()) {
      throw new ValidationError("Eräpäivä ei voi olla ennen laskun päivää.");
    }
    data.dueDate = dueDate;
  }

  if (input.gross !== undefined || input.vat !== undefined) {
    const { grossCents, vatCents, netCents } = purchaseAmounts(
      input.gross ?? centsToEuros(existing.grossCents),
      input.vat ?? centsToEuros(existing.vatCents)
    );
    const paidCents = existing.payments.reduce((sum, payment) => sum + payment.amountCents, 0);
    if (paidCents > 0 && grossCents < paidCents) {
      throw new AppError(
        "Summa on pienempi kuin jo kirjatut maksut.",
        "AMOUNT_BELOW_PAYMENTS",
        409
      );
    }
    if (grossCents < creditedCentsOf(existing.creditNotes)) {
      throw new AppError(
        "Summa on pienempi kuin jo hyvitetty summa.",
        "AMOUNT_BELOW_CREDITS",
        409
      );
    }
    data.grossCents = grossCents;
    data.vatCents = vatCents;
    data.netCents = netCents;
  }

  if (input.receiptId !== undefined) {
    if (input.receiptId) await assertReceiptAvailable(userId, input.receiptId, id);
    data.receiptId = input.receiptId;
  }

  if (input.status !== undefined) {
    if (input.status === "cancelled" && existing.payments.length > 0) {
      throw new AppError(
        "Laskulla on maksuja, joten sitä ei voi mitätöidä.",
        "INVOICE_HAS_PAYMENTS",
        409
      );
    }
    if (input.status === "cancelled" && creditedCentsOf(existing.creditNotes) > 0) {
      throw new AppError(
        "Laskulla on hyvityslasku. Mitätöi hyvityslasku ensin.",
        "INVOICE_HAS_CREDIT_NOTES",
        409
      );
    }
    if (input.status === "paid") {
      const paidCents = existing.payments.reduce((sum, payment) => sum + payment.amountCents, 0);
      const reason = input.closeReason?.trim() ?? "";
      if (paidCents < existing.grossCents && reason.length < 3) {
        throw new AppError(
          "Ostolaskua ei voi merkitä maksetuksi ilman maksukirjausta tai vähintään kolmen merkin perustelua.",
          "PAID_REQUIRES_SETTLEMENT",
          409
        );
      }
      data.status = "paid";
      data.paidAt = existing.paidAt ?? new Date();
      if (reason) {
        data.closedReason = reason;
        data.closedAt = new Date();
      }
    } else {
      data.status = input.status;
      data.paidAt = null;
      data.closedReason = null;
      data.closedAt = null;
    }
  }

  const updated = await prisma.purchaseInvoice.update({
    where: { id },
    data,
    include: purchaseInclude,
  });
  // Cancelling or restoring a credit note changes what its invoice still owes.
  if (isCreditNote && existing.creditsInvoiceId && input.status !== undefined) { // wave2-schema: PurchaseInvoice.creditsInvoiceId / creditNotes
    await settleAfterCredit(prisma, existing.creditsInvoiceId); // wave2-schema: PurchaseInvoice.creditsInvoiceId / creditNotes
  }
  return toPublicPurchaseInvoice(updated);
}

export async function deletePurchaseInvoice(userId: string, id: string): Promise<void> {
  const existing = await prisma.purchaseInvoice.findFirst({
    where: { id, userId },
    include: {
      payments: { select: { id: true } },
      creditNotes: { select: { status: true } }, // wave2-schema: PurchaseInvoice.creditsInvoiceId / creditNotes
    },
  });
  if (!existing) throw new NotFoundError("Ostolaskua ei löytynyt.");
  await assertPeriodOpen(userId, [existing.issueDate]);
  if (existing.payments.length > 0) {
    throw new AppError(
      "Laskulla on maksuja. Poista maksut ensin tai mitätöi lasku.",
      "INVOICE_HAS_PAYMENTS",
      409
    );
  }
  if (existing.creditNotes.some((note) => note.status !== "cancelled")) {
    throw new AppError(
      "Laskulla on hyvityslasku. Poista hyvityslasku ensin.",
      "INVOICE_HAS_CREDIT_NOTES",
      409
    );
  }
  await prisma.purchaseInvoice.delete({ where: { id } });
  // The invoice a deleted credit note corrected owes the credited amount again.
  if (existing.creditsInvoiceId) await settleAfterCredit(prisma, existing.creditsInvoiceId); // wave2-schema: PurchaseInvoice.creditsInvoiceId / creditNotes
}

export async function getPurchaseInvoice(
  userId: string,
  id: string,
  db: Prisma.TransactionClient | typeof prisma = prisma
): Promise<PublicPurchaseInvoice> {
  const invoice = await db.purchaseInvoice.findFirst({
    where: { id, userId },
    include: purchaseInclude,
  });
  if (!invoice) throw new NotFoundError("Ostolaskua ei löytynyt.");
  return toPublicPurchaseInvoice(invoice);
}

/* ------------------------------------------------------------------ */
/* Supplier credit notes (hyvityslasku)                                 */
/* ------------------------------------------------------------------ */

const CREDIT_NOTE_WORDING = /hyvityslasku|hyvitys\s+lasku|credit\s*note|kreditnota|kreditfaktura|gutschrift/i;

/**
 * Whether a document the AI read as a bill is really a supplier's credit note:
 * the reading names it so, the total is negative, or the head of the document
 * says hyvityslasku / credit note. Pure: it only looks at what extraction left on
 * the receipt. The wording is looked for in the notes, the file name and the
 * first lines of the text - a payable that merely mentions credit notes in its
 * terms further down stays a payable.
 */
export function isCreditNoteExtraction(
  receipt: {
    totalAmountCents?: number | null;
    notes?: string | null;
    rawText?: string | null;
    fileName?: string | null;
  },
  reading: { documentType?: string | null } | null
): boolean {
  const type = reading?.documentType ?? null;
  // A document type the reading step may report itself (never produced by the current prompt).
  if (type === "credit_note" || type === "creditNote") return true;
  if (type !== "invoice") return false;
  if ((receipt.totalAmountCents ?? 0) < 0) return true;
  const head = [receipt.notes, receipt.fileName, receipt.rawText?.slice(0, 400)].filter(Boolean).join(" ");
  return CREDIT_NOTE_WORDING.test(head);
}

/**
 * Re-derives the status of an invoice from what is paid and credited:
 * fully credited, settled by payments plus credits, or open. A cancelled
 * invoice and a write-off close (closedReason) are left as they are.
 */
async function settleAfterCredit(db: Prisma.TransactionClient | typeof prisma, invoiceId: string): Promise<void> {
  const invoice = await db.purchaseInvoice.findUnique({
    where: { id: invoiceId },
    select: {
      status: true,
      grossCents: true,
      closedReason: true,
      paidAt: true,
      payments: { select: { amountCents: true } },
      creditNotes: { select: { grossCents: true, status: true } }, // wave2-schema: PurchaseInvoice.creditsInvoiceId / creditNotes
    },
  });
  if (!invoice || invoice.status === "cancelled" || invoice.grossCents < 0) return;
  const paid = invoice.payments.reduce((sum, payment) => sum + payment.amountCents, 0);
  const credited = creditedCentsOf(invoice.creditNotes);
  const next: PurchaseStatus =
    credited >= invoice.grossCents
      ? "credited"
      : invoice.closedReason?.trim() || paid + credited >= invoice.grossCents
        ? "paid"
        : "open";
  if (next === invoice.status) return;
  await db.purchaseInvoice.update({
    where: { id: invoiceId },
    data:
      next === "paid"
        ? { status: next, paidAt: invoice.paidAt ?? new Date() }
        : next === "open"
          ? { status: next, paidAt: null }
          : { status: next },
  });
}

export interface PurchaseCreditInput {
  /** Cents to credit; omitted = everything still creditable. */
  amountCents?: number;
  /** VAT inside the credit, in cents; omitted = the original's VAT pro rata. */
  vatCents?: number;
  /** Why the supplier credited (shown on the credit note). */
  reason: string;
  /** The credit note's date, YYYY-MM-DD: the VAT period it counts in. */
  date: string;
  /** The number printed on the supplier's credit note, if any. */
  supplierNumber?: string | null;
}

/**
 * Records a supplier's credit note against an ostolasku: a row with a negative
 * total (`creditsInvoiceId` = the original). It reduces what is owed - the
 * original keeps its figures, its open amount is gross - paid - credited - and
 * the original turns "credited" only when nothing remains creditable. Posting
 * and the VAT return read the row like any other ostolasku, so they get the
 * mirror image with negative signs; there is no separate path.
 *
 * Over-credit is refused (409), as are crediting a credit note or a cancelled
 * invoice. `db`: the transaction of an idempotent request, as createPurchaseInvoice.
 */
export async function createPurchaseCreditNote(
  userId: string,
  invoiceId: string,
  input: PurchaseCreditInput,
  db?: Prisma.TransactionClient
): Promise<{ creditNote: PublicPurchaseInvoice; invoice: PublicPurchaseInvoice }> {
  const reason = input.reason?.trim() ?? "";
  if (reason.length < 3) throw new ValidationError("Kirjoita hyvityksen syy (vähintään kolme merkkiä).");
  const issueDate = isoDateToUtc(input.date);

  const write = async (tx: Prisma.TransactionClient) => {
    // A write comes first: it takes the write lock, so the creditable remainder
    // read below is still true when this transaction commits.
    await tx.$executeRaw`UPDATE "PurchaseInvoice" SET "grossCents" = "grossCents" WHERE "id" = ${invoiceId} AND "userId" = ${userId}`;
    const original = await tx.purchaseInvoice.findFirst({
      where: { id: invoiceId, userId },
      include: { creditNotes: { select: { grossCents: true, vatCents: true, status: true } } }, // wave2-schema: PurchaseInvoice.creditsInvoiceId / creditNotes
    });
    if (!original) throw new NotFoundError("Ostolaskua ei löytynyt.");
    if (original.grossCents < 0) {
      throw new AppError("Hyvityslaskua ei hyvitetä uudelleen.", "CREDIT_NOTE_REQUIRED", 409);
    }
    if (original.status === "cancelled") {
      throw new AppError("Mitätöityä ostolaskua ei hyvitetä.", "INVOICE_CANCELLED", 409);
    }
    if (issueDate.getTime() < original.issueDate.getTime()) {
      throw new ValidationError("Hyvityksen päivä ei voi olla ennen ostolaskun päivää.");
    }
    await assertPeriodOpen(userId, [issueDate], tx);

    const live = original.creditNotes.filter((note) => note.status !== "cancelled");
    const creditedGross = live.reduce((sum, note) => sum - note.grossCents, 0);
    const creditedVat = live.reduce((sum, note) => sum - note.vatCents, 0);
    const remaining = original.grossCents - creditedGross;
    if (remaining <= 0) throw new AppError("Lasku on jo hyvitetty.", "ALREADY_CREDITED", 409);

    const amountCents = input.amountCents ?? remaining;
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      throw new ValidationError("Hyvityksen summan on oltava positiivinen.");
    }
    if (amountCents > remaining) {
      throw new AppError(
        `Hyvitys ${formatEur(centsToEuros(amountCents))} ylittää hyvitettävissä olevan summan ${formatEur(centsToEuros(remaining))}.`,
        "CREDIT_EXCEEDS_REMAINING",
        409,
        { remainingCents: remaining }
      );
    }
    // The last credit takes the VAT that is left, so the credits add up to the
    // original's VAT to the cent whatever the pro rata rounded to before.
    const vatCents =
      input.vatCents ??
      (amountCents === remaining
        ? Math.max(0, original.vatCents - creditedVat)
        : Math.round((original.vatCents * amountCents) / original.grossCents));
    if (!Number.isInteger(vatCents) || vatCents < 0 || vatCents > amountCents) {
      throw new ValidationError("Hyvityksen ALV ei voi olla negatiivinen eikä suurempi kuin hyvityksen summa.");
    }
    await assertInvoiceNumberFree(userId, original.supplierName, input.supplierNumber, tx);

    const created = await tx.purchaseInvoice.create({
      data: {
        userId,
        supplierName: original.supplierName,
        supplierBusinessId: original.supplierBusinessId,
        supplierIban: original.supplierIban,
        invoiceNumber: input.supplierNumber?.trim() || null,
        issueDate,
        dueDate: issueDate,
        // Nothing is payable on a credit note, but the VAT return only counts open and paid rows.
        status: "paid",
        paidAt: issueDate,
        grossCents: -amountCents,
        vatCents: -vatCents,
        netCents: -(amountCents - vatCents),
        category: original.category,
        notes: `Hyvitys ostolaskulle${original.invoiceNumber ? ` ${original.invoiceNumber}` : ""}: ${reason}`.slice(0, 2000),
        currency: original.currency,
        originalAmountCents:
          original.originalAmountCents == null
            ? null
            : -Math.round((original.originalAmountCents * amountCents) / original.grossCents),
        vatTreatment: original.vatTreatment,
        creditsInvoiceId: original.id, // wave2-schema: PurchaseInvoice.creditsInvoiceId / creditNotes
      },
      select: { id: true },
    });
    await settleAfterCredit(tx, original.id);
    return created.id;
  };

  const creditId = db ? await write(db) : await prisma.$transaction(write);
  const client = db ?? prisma;
  return {
    creditNote: await getPurchaseInvoice(userId, creditId, client),
    invoice: await getPurchaseInvoice(userId, invoiceId, client),
  };
}

/**
 * A document the reading took for a supplier's credit note, filed on its own:
 * the original is not named on it, so the credit is not linked to an ostolasku
 * (the owner sees it under Hyvitetyt). The receipt stays linked as the document
 * and is left out of the VAT return (loadCountedReceipts), so the credit counts
 * once and with a negative sign instead of as an expense.
 */
async function fileReceiptAsPurchaseCredit(
  userId: string,
  receipt: {
    id: string;
    vendor: string | null;
    date: Date | null;
    invoiceNumber: string | null;
    totalAmountCents: number | null;
    vatDetails: string | null;
    category: string | null;
    currency: string;
    originalAmountCents: number | null;
    vatTreatment: string;
    type: string;
  },
  // The inbox files inside its own transaction (receipt-staging.ts): writing
  // through the global client there would wait on that transaction's lock.
  db?: Prisma.TransactionClient
): Promise<
  | { created: true; invoice: PublicPurchaseInvoice }
  | { created: false; skipped: "sales_document" | "no_supplier" | "no_date" | "no_amount" | "duplicate" }
> {
  if (receipt.type === "tulo") return { created: false, skipped: "sales_document" };
  const supplierName = receipt.vendor?.trim();
  if (!supplierName) return { created: false, skipped: "no_supplier" };
  if (!receipt.date) return { created: false, skipped: "no_date" };
  // A credit note's total is read as printed, with or without its minus sign.
  const grossCents = Math.abs(receipt.totalAmountCents ?? 0);
  if (grossCents === 0) return { created: false, skipped: "no_amount" };
  const vatCents = Math.min(grossCents, Math.abs(eurosToCents(receiptVatTotalEuros(receipt.vatDetails))));
  const issueDate = receipt.date;
  const client = db ?? prisma;
  try {
    await assertPeriodOpen(userId, [issueDate], client);
    await assertReceiptAvailable(userId, receipt.id, undefined, client);
    await assertInvoiceNumberFree(userId, supplierName, receipt.invoiceNumber, client);
    const created = await client.purchaseInvoice.create({
      data: {
        userId,
        supplierName,
        invoiceNumber: receipt.invoiceNumber?.trim() || null,
        issueDate,
        dueDate: issueDate,
        status: "paid",
        paidAt: issueDate,
        grossCents: -grossCents,
        vatCents: -vatCents,
        netCents: -(grossCents - vatCents),
        category: receipt.category,
        notes: "Hyvityslasku",
        receiptId: receipt.id,
        currency: receipt.currency,
        originalAmountCents:
          receipt.originalAmountCents == null ? null : -Math.abs(receipt.originalAmountCents),
        vatTreatment: isPurchaseVatTreatment(receipt.vatTreatment) ? receipt.vatTreatment : "domestic",
      },
      include: purchaseInclude,
    });
    return { created: true, invoice: toPublicPurchaseInvoice(created) };
  } catch (error) {
    // The receipt already documents an invoice or credit note: filed before.
    if (error instanceof AppError && (error.code === "DUPLICATE_PURCHASE_INVOICE" || error.code === "RECEIPT_IN_USE")) {
      return { created: false, skipped: "duplicate" };
    }
    throw error;
  }
}

export interface PurchaseReceiptCandidate {
  id: string;
  vendor: string | null;
  date: string | null;
  gross: number | null;
  reviewStatus: string;
  /** Same amount as the invoice: the likeliest candidate, listed first. */
  sameAmount: boolean;
}

const CANDIDATE_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;
const CANDIDATE_LIMIT = 8;

/**
 * The receipts an owner can link to a purchase invoice (it is the same
 * purchase), plus the one already linked. Candidates are expense receipts that
 * no other invoice has, near the invoice in time, the same amount or the same
 * supplier first.
 */
export async function listReceiptCandidatesForPurchase(
  userId: string,
  invoiceId: string
): Promise<{ linked: PurchaseReceiptCandidate | null; candidates: PurchaseReceiptCandidate[] }> {
  const invoice = await prisma.purchaseInvoice.findFirst({
    where: { id: invoiceId, userId },
    select: { id: true, supplierName: true, grossCents: true, issueDate: true, receiptId: true },
  });
  if (!invoice) throw new NotFoundError("Ostolaskua ei löytynyt.");

  const select = { id: true, vendor: true, date: true, totalAmountCents: true, reviewStatus: true } as const;
  const toCandidate = (receipt: {
    id: string;
    vendor: string | null;
    date: Date | null;
    totalAmountCents: number | null;
    reviewStatus: string;
  }): PurchaseReceiptCandidate => ({
    id: receipt.id,
    vendor: receipt.vendor,
    date: receipt.date ? receipt.date.toISOString().slice(0, 10) : null,
    gross: receipt.totalAmountCents == null ? null : centsToEuros(receipt.totalAmountCents),
    reviewStatus: receipt.reviewStatus,
    sameAmount: receipt.totalAmountCents === invoice.grossCents,
  });

  const linkedReceipt = invoice.receiptId
    ? await prisma.receipt.findFirst({ where: { id: invoice.receiptId, userId }, select })
    : null;
  const nearby = await prisma.receipt.findMany({
    where: {
      userId,
      type: "meno",
      reviewStatus: { in: ["approved", "pending"] },
      purchaseInvoice: { is: null },
      date: {
        gte: new Date(invoice.issueDate.getTime() - CANDIDATE_WINDOW_MS),
        lte: new Date(invoice.issueDate.getTime() + CANDIDATE_WINDOW_MS),
      },
    },
    select,
  });
  const supplier = invoice.supplierName.trim().toLowerCase();
  const gap = (receipt: { date: Date | null }) =>
    receipt.date ? Math.abs(receipt.date.getTime() - invoice.issueDate.getTime()) : Number.MAX_SAFE_INTEGER;
  const candidates = nearby
    .filter(
      (receipt) =>
        receipt.totalAmountCents === invoice.grossCents ||
        (receipt.vendor ?? "").trim().toLowerCase() === supplier
    )
    .sort((a, b) => {
      const amount = Number(b.totalAmountCents === invoice.grossCents) - Number(a.totalAmountCents === invoice.grossCents);
      return amount !== 0 ? amount : gap(a) - gap(b);
    })
    .slice(0, CANDIDATE_LIMIT)
    .map(toCandidate);
  return { linked: linkedReceipt ? toCandidate(linkedReceipt) : null, candidates };
}

export interface RecordPurchasePaymentInput {
  amount: number;
  paidDate: string;
  transactionId?: string | null;
  note?: string | null;
  source?: "manual" | "bank";
}

/**
 * Records a payment on a payable. A payment keyed in by hand may not exceed
 * what is still owed, be dated in the future or before the invoice (the same
 * rules as a sales payment). The balance is read in the same transaction as the
 * insert, after a write has taken SQLite's write lock, so two payments that
 * arrive together cannot both fit. A payment that carries a bank row
 * (`transactionId`, or `source: "bank"`) records what the bank says happened
 * and is not refused on the open amount or the date; it must be a payment out
 * of the owner's account that no other invoice holds, and may be part of the
 * row (a partial payment) but never more than the row paid.
 */
/** `db`: the transaction of an idempotent request; without it the payment opens its own. */
export async function recordPurchasePayment(
  userId: string,
  invoiceId: string,
  input: RecordPurchasePaymentInput,
  db?: Prisma.TransactionClient
): Promise<PublicPurchaseInvoice> {
  const amountCents = eurosToCents(input.amount);
  if (amountCents <= 0) throw new ValidationError("Maksun summan on oltava positiivinen.");
  const source = input.transactionId ? "bank" : (input.source ?? "manual");
  const manual = source === "manual";
  if (manual && input.paidDate > helsinkiCalendarDate()) {
    throw new AppError("Maksupäivä ei voi olla tulevaisuudessa.", "PAYMENT_IN_FUTURE", 422);
  }

  const write = async (tx: Prisma.TransactionClient) => {
    // A write comes first: it takes the write lock, so the balance read below
    // is still true when this transaction commits.
    await tx.$executeRaw`UPDATE "PurchaseInvoice" SET "grossCents" = "grossCents" WHERE "id" = ${invoiceId} AND "userId" = ${userId}`;

    const invoice = await tx.purchaseInvoice.findFirst({
      where: { id: invoiceId, userId },
      include: purchaseInclude,
    });
    if (!invoice) throw new NotFoundError("Ostolaskua ei löytynyt.");
    if (invoice.status === "cancelled") {
      throw new AppError("Mitätöidylle laskulle ei voi kirjata maksua.", "INVOICE_CANCELLED", 409);
    }
    if (invoice.grossCents < 0 || invoice.status === "credited") {
      throw new AppError("Hyvitetylle laskulle ei voi kirjata maksua.", "INVOICE_CREDITED", 409);
    }

    await assertPeriodOpen(userId, [isoDateToUtc(input.paidDate)], tx);

    if (manual && isoDateToUtc(input.paidDate) < invoice.issueDate) {
      throw new AppError(
        `Maksupäivä (${formatDate(input.paidDate)}) on ennen ostolaskun päivää (${formatDate(invoice.issueDate.toISOString())}).`,
        "PAYMENT_BEFORE_INVOICE",
        422
      );
    }

    if (input.transactionId) {
      const transaction = await tx.transaction.findFirst({
        where: { id: input.transactionId, statement: { userId } },
        select: { id: true, amountCents: true, invoicePayment: { select: { id: true } } },
      });
      if (!transaction) throw new NotFoundError("Tapahtumaa ei löytynyt.");
      const taken = await tx.purchasePayment.findUnique({
        where: { transactionId: input.transactionId },
        select: { id: true },
      });
      if (taken) {
        throw new AppError(
          "Tämä pankkitapahtuma on jo kohdistettu ostolaskulle.",
          "TRANSACTION_ALREADY_USED",
          409
        );
      }
      if (transaction.invoicePayment) {
        throw new AppError(
          "Tämä pankkitapahtuma on jo kohdistettu myyntilaskulle.",
          "TRANSACTION_ALREADY_USED",
          409
        );
      }
      if (transaction.amountCents >= 0) {
        throw new AppError(
          "Ostolaskun maksuksi voi kohdistaa vain lähtevän maksun.",
          "TRANSACTION_NOT_OUTGOING",
          422
        );
      }
      const rowCents = Math.abs(transaction.amountCents);
      if (amountCents > rowCents) {
        throw new AppError(
          `Maksu on suurempi kuin pankkitapahtuman summa (${formatEur(centsToEuros(rowCents))}).`,
          "PAYMENT_EXCEEDS_TRANSACTION",
          422,
          { rowCents }
        );
      }
    }

    const paidBefore = invoice.payments.reduce((sum, payment) => sum + payment.amountCents, 0);
    // A part credit leaves the invoice open for the rest: that is what a payment may cover.
    const owedCents = invoice.grossCents - creditedCentsOf(invoice.creditNotes);
    const openCents = owedCents - paidBefore;
    if (manual && amountCents > openCents) {
      throw new AppError(
        openCents <= 0
          ? `Ostolasku on jo maksettu. Avoin summa on ${formatEur(0)}.`
          : `Maksu on suurempi kuin ostolaskun avoin summa (${formatEur(centsToEuros(openCents))}). Kirjaa enintään avoin summa.`,
        "PAYMENT_EXCEEDS_OPEN",
        422,
        { openCents }
      );
    }

    await tx.purchasePayment.create({
      data: {
        purchaseInvoiceId: invoiceId,
        transactionId: input.transactionId ?? null,
        paidDate: isoDateToUtc(input.paidDate),
        amountCents,
        source,
        note: input.note?.trim() || null,
      },
    });

    if (paidBefore + amountCents >= owedCents && invoice.status === "open") {
      await tx.purchaseInvoice.update({
        where: { id: invoiceId },
        data: { status: "paid", paidAt: isoDateToUtc(input.paidDate) },
      });
    }
  };

  if (db) {
    await write(db);
    return getPurchaseInvoice(userId, invoiceId, db);
  }
  await prisma.$transaction(write);
  return getPurchaseInvoice(userId, invoiceId);
}

export async function removePurchasePayment(
  userId: string,
  invoiceId: string,
  paymentId: string
): Promise<PublicPurchaseInvoice> {
  const invoice = await prisma.purchaseInvoice.findFirst({
    where: { id: invoiceId, userId },
    select: {
      id: true,
      status: true,
      grossCents: true,
      closedReason: true,
      creditNotes: { select: { grossCents: true, status: true } }, // wave2-schema: PurchaseInvoice.creditsInvoiceId / creditNotes
    },
  });
  if (!invoice) throw new NotFoundError("Ostolaskua ei löytynyt.");

  const payment = await prisma.purchasePayment.findFirst({
    where: { id: paymentId, purchaseInvoiceId: invoiceId },
    select: { paidDate: true },
  });
  if (!payment) throw new NotFoundError("Maksua ei löytynyt.");
  await assertPeriodOpen(userId, [payment.paidDate]);

  const deleted = await prisma.purchasePayment.deleteMany({
    where: { id: paymentId, purchaseInvoiceId: invoiceId },
  });
  if (deleted.count === 0) throw new NotFoundError("Maksua ei löytynyt.");

  if (invoice.status === "paid" && !invoice.closedReason?.trim()) {
    const remaining = await prisma.purchasePayment.aggregate({
      where: { purchaseInvoiceId: invoiceId },
      _sum: { amountCents: true },
    });
    if ((remaining._sum.amountCents ?? 0) < invoice.grossCents - creditedCentsOf(invoice.creditNotes)) {
      await prisma.purchaseInvoice.update({
        where: { id: invoiceId },
        data: { status: "open", paidAt: null },
      });
    }
  }

  return getPurchaseInvoice(userId, invoiceId);
}

export interface ListPurchaseOptions {
  status?: PurchaseStatus | "overdue" | "all";
  month?: string;
  limit?: number;
}

export interface PurchaseListResult {
  invoices: PublicPurchaseInvoice[];
  aging: AgingReport & { totalOpen: number; overdue: number };
}

export async function listPurchaseInvoices(
  userId: string,
  options: ListPurchaseOptions = {},
  now: Date = new Date()
): Promise<PurchaseListResult> {
  const where: Record<string, unknown> = { userId };
  if (options.status === "overdue") {
    // Open payables age like unpaid sales invoices. Apply that before `take`,
    // or 200 earlier non-open rows can crowd the overdue one out of the page.
    where.status = "open";
    where.dueDate = { lt: overdueBefore(now) };
  } else if (options.status === "credited") {
    // A credit note belongs with the invoices it corrects, never under "Maksetut".
    where.OR = [{ status: "credited" }, { grossCents: { lt: 0 }, status: { not: "cancelled" } }];
  } else if (options.status === "paid") {
    where.status = "paid";
    where.grossCents = { gte: 0 };
  } else if (options.status && options.status !== "all") {
    where.status = options.status;
  }
  if (options.month) {
    const [year, month] = options.month.split("-").map(Number);
    where.issueDate = {
      gte: new Date(Date.UTC(year, month - 1, 1)),
      lt: new Date(Date.UTC(year, month, 1)),
    };
  }

  const rows = await prisma.purchaseInvoice.findMany({
    where,
    include: purchaseInclude,
    orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
    take: options.limit ?? 200,
  });

  const invoices = rows.map((row) => toPublicPurchaseInvoice(row, now));

  const open = await prisma.purchaseInvoice.findMany({
    where: { userId, status: { in: ["open", "paid"] } },
    select: {
      status: true,
      dueDate: true,
      grossCents: true,
      closedReason: true,
      payments: { select: { amountCents: true } },
      creditNotes: { select: { grossCents: true, status: true } }, // wave2-schema: PurchaseInvoice.creditsInvoiceId / creditNotes
    },
  });
  const aging = buildAging(
    open.map((invoice) => {
      const paidCents = invoice.payments.reduce((sum, payment) => sum + payment.amountCents, 0);
      const position = openPosition({
        status: invoice.status,
        grossCents: invoice.grossCents,
        paidCents,
        creditedCents: creditedCentsOf(invoice.creditNotes),
        closedReason: invoice.closedReason,
      });
      return {
        dueDate: invoice.dueDate,
        openCents: position.collectible ? position.openCents : 0,
      };
    }),
    now
  );

  return {
    invoices,
    aging: {
      ...aging,
      totalOpen: centsToEuros(aging.totalOpenCents),
      overdue: centsToEuros(aging.overdueCents),
    },
  };
}

export interface PurchaseInvoiceStatusCounts {
  open: number;
  overdue: number;
  paid: number;
  /** Credited invoices and the credit notes themselves. */
  credited: number;
  cancelled: number;
}

/**
 * DB-side counts per display status, for the purchase list's filter chips.
 * `listPurchaseInvoices` caps its rows at 200 (see `take` above), so counting
 * the fetched rows themselves would silently undercount past that cap - this
 * counts the whole table instead, with the same overdue semantics
 * (`overdueBefore`) `listPurchaseInvoices` uses.
 */
export async function countPurchaseInvoicesByDisplayStatus(
  userId: string,
  now: Date = new Date()
): Promise<PurchaseInvoiceStatusCounts> {
  const dueBefore = overdueBefore(now);
  const [open, overdue, paid, credited, cancelled] = await Promise.all([
    prisma.purchaseInvoice.count({
      where: { userId, status: "open", dueDate: { gte: dueBefore } },
    }),
    prisma.purchaseInvoice.count({
      where: { userId, status: "open", dueDate: { lt: dueBefore } },
    }),
    prisma.purchaseInvoice.count({ where: { userId, status: "paid", grossCents: { gte: 0 } } }),
    prisma.purchaseInvoice.count({
      where: { userId, OR: [{ status: "credited" }, { grossCents: { lt: 0 }, status: { not: "cancelled" } }] },
    }),
    prisma.purchaseInvoice.count({ where: { userId, status: "cancelled" } }),
  ]);
  return { open, overdue, paid, credited, cancelled };
}

export interface PurchaseMatchSuggestion {
  invoiceId: string;
  supplierName: string;
  invoiceNumber: string | null;
  /** What is still owed on the invoice. */
  open: number;
  transactionId: string;
  /** What the bank row paid (positive). */
  amount: number;
  /** The bank row's date: the payment date "Hyväksy" records. */
  paidDate: string | null;
  counterparty: string | null;
  score: number;
  /** Exact open amount plus the supplier's name (or a viite in the message): never the amount alone. */
  reason: "amount_and_party";
  /** Finnish reasons ("summa sama", "nimi vastaa"). */
  reasons: string[];
}

export interface PurchaseMatchResult {
  applied: Array<{ invoiceId: string; supplierName: string; transactionId: string; amount: number }>;
  /** Reference hits that fall inside a closed period and were left alone. */
  skippedLocked: Array<{ invoiceId: string; supplierName: string; transactionId: string }>;
  /**
   * Pairs for the owner to accept ("Hyväksy": POST /api/purchase-invoices/[id]/payments
   * with `transactionId`, `amount`, `paidDate`) or reject (POST /api/purchase-invoices/match/reject).
   */
  suggestions: PurchaseMatchSuggestion[];
}

type OpenPurchase = Prisma.PurchaseInvoiceGetPayload<{
  include: {
    payments: { select: { amountCents: true } };
    creditNotes: { select: { grossCents: true; status: true } }; // wave2-schema: PurchaseInvoice.creditsInvoiceId / creditNotes
    receipt: { select: { reference: true } };
  };
}>;
type OutgoingRow = {
  id: string;
  amountCents: number;
  date: Date | null;
  reference: string | null;
  message: string | null;
  counterparty: string | null;
  receiptId: string | null;
};

async function loadMatchInputs(userId: string): Promise<{ openInvoices: OpenPurchase[]; outgoing: OutgoingRow[] }> {
  const openInvoices = await prisma.purchaseInvoice.findMany({
    where: { userId, status: "open", grossCents: { gt: 0 } },
    include: {
      payments: { select: { amountCents: true } },
      creditNotes: { select: { grossCents: true, status: true } }, // wave2-schema: PurchaseInvoice.creditsInvoiceId / creditNotes
      receipt: { select: { reference: true } },
    },
  });
  // Bills filed from a receipt before W27 were stored without the viite the receipt
  // carries; matching reads it from the receipt, so they are paid like new ones.
  for (const invoice of openInvoices) {
    if (!invoice.reference) invoice.reference = readReference(invoice.receipt?.reference);
  }
  if (openInvoices.length === 0) return { openInvoices, outgoing: [] };
  const outgoing = await prisma.transaction.findMany({
    where: { statement: { userId }, amountCents: { lt: 0 }, purchasePayment: null, invoicePayment: null },
    select: {
      id: true,
      amountCents: true,
      date: true,
      reference: true,
      message: true,
      counterparty: true,
      receiptId: true,
    },
  });
  return { openInvoices, outgoing };
}

/**
 * The exact open amount AND the supplier's name, inside the payment window
 * (match-gate.ts); two equally plausible payables give no suggestion. A pair the
 * owner rejected is not suggested again, and a row documented by another
 * receipt is left alone (it is that receipt's purchase).
 */
async function planPurchaseSuggestions(
  userId: string,
  openInvoices: OpenPurchase[],
  outgoing: OutgoingRow[]
): Promise<PurchaseMatchSuggestion[]> {
  if (openInvoices.length === 0 || outgoing.length === 0) return [];
  const rejected = await rejectedPurchasePairs(userId);
  const rowById = new Map(outgoing.map((row) => [row.id, row]));
  const invoiceById = new Map(openInvoices.map((invoice) => [invoice.id, invoice]));
  // Settled = paid or credited: the bank pays what a credit note left.
  const paidOf = (invoice: OpenPurchase) =>
    invoice.payments.reduce((sum, payment) => sum + payment.amountCents, 0) + creditedCentsOf(invoice.creditNotes);
  const plan = planPairs(
    outgoing.map((row) => ({ ...row, amountCents: Math.abs(row.amountCents), counterpartyIban: null })),
    openInvoices.map((invoice) => ({
      id: invoice.id,
      kind: "lasku" as const,
      date: invoice.issueDate,
      dueDate: invoice.dueDate,
      amountCents: invoice.grossCents - creditedCentsOf(invoice.creditNotes),
      openCents: invoice.grossCents - paidOf(invoice),
      party: invoice.supplierName,
      reference: invoice.reference,
      invoiceNumber: invoice.invoiceNumber,
      iban: invoice.supplierIban,
    })),
    (rowId, invoiceId) => {
      const row = rowById.get(rowId)!;
      const invoice = invoiceById.get(invoiceId)!;
      if (invoice.grossCents - paidOf(invoice) <= 0) return false;
      if (rejected.has(`${rowId}:${invoiceId}`)) return false;
      if (row.receiptId && row.receiptId !== invoice.receiptId) return false;
      return !row.date || row.date.getTime() >= invoice.issueDate.getTime();
    }
  );
  return plan.picks.map((pick) => {
    const invoice = invoiceById.get(pick.candidateId)!;
    const row = rowById.get(pick.rowId)!;
    return {
      invoiceId: invoice.id,
      supplierName: invoice.supplierName,
      invoiceNumber: invoice.invoiceNumber,
      open: centsToEuros(invoice.grossCents - paidOf(invoice)),
      transactionId: row.id,
      amount: centsToEuros(Math.abs(row.amountCents)),
      paidDate: row.date ? row.date.toISOString().slice(0, 10) : null,
      counterparty: row.counterparty,
      score: pick.verdict.score,
      reason: "amount_and_party" as const,
      reasons: pick.verdict.reasons,
    };
  });
}

/** The suggestions alone, nothing written: what the Ostolaskut list shows as "N ehdotusta". */
export async function listPurchaseSuggestions(userId: string): Promise<PurchaseMatchSuggestion[]> {
  const { openInvoices, outgoing } = await loadMatchInputs(userId);
  return planPurchaseSuggestions(userId, openInvoices, outgoing);
}

/**
 * Matches outgoing bank rows against open payables. As on the sales side, only
 * a reference hit is applied automatically; an amount coincidence is a
 * suggestion, never a posting.
 */
export async function matchPurchasePaymentsFromBank(
  userId: string,
  now: Date = new Date()
): Promise<PurchaseMatchResult> {
  const { openInvoices, outgoing } = await loadMatchInputs(userId);
  if (openInvoices.length === 0) return { applied: [], suggestions: [], skippedLocked: [] };

  // Several open invoices can share a fixed viite (a monthly rent): all of them are kept, and the
  // payment goes to the one whose open amount it is (audit 2026-10-09: the last one took every
  // payment, and a payment larger than the invoice was booked and marked paid).
  const byReference = new Map<string, OpenPurchase[]>();
  for (const invoice of openInvoices) {
    if (!invoice.reference) continue;
    byReference.set(invoice.reference, [...(byReference.get(invoice.reference) ?? []), invoice]);
  }
  const openCents = (invoice: OpenPurchase) =>
    invoice.grossCents -
    creditedCentsOf(invoice.creditNotes) -
    invoice.payments.reduce((sum, payment) => sum + payment.amountCents, 0);
  const applied: PurchaseMatchResult["applied"] = [];
  const skippedLocked: PurchaseMatchResult["skippedLocked"] = [];
  const consumed = new Set<string>();

  // Exact amounts first, over every row, then part payments. A fixed viite (freight, a pension
  // fund) is on months of earlier payments; the first one met was booked as a part of the new
  // bill that a later row paid exactly (W27, owner's data, now that this runs after every sync).
  for (const partial of [false, true]) {
    for (const transaction of outgoing) {
      if (consumed.has(transaction.id)) continue;
      const candidates = [transaction.reference, transaction.message]
        .filter((value): value is string => Boolean(value))
        .map(normalizeReference);
      const sharing = candidates.map((value) => byReference.get(value)).find((list) => list && list.length > 0);
      if (!sharing) continue;
      // A payment made before the bill's date paid an earlier bill with the same viite.
      const dated = sharing.filter(
        (candidate) => !transaction.date || transaction.date.getTime() >= candidate.issueDate.getTime()
      );
      const paid = Math.abs(transaction.amountCents);
      // The invoice of exactly this amount; else, alone with the viite, one this payment does not
      // exceed (a part payment). An overpayment, or a choice between invoices, is left to the owner.
      const invoice = partial
        ? dated.length === 1 && paid < openCents(dated[0])
          ? dated[0]
          : undefined
        : dated.find((candidate) => openCents(candidate) === paid);
      if (!invoice) continue;

      const amount = centsToEuros(Math.abs(transaction.amountCents));
      try {
        await recordPurchasePayment(userId, invoice.id, {
          amount,
          paidDate: (transaction.date ?? now).toISOString().slice(0, 10),
          transactionId: transaction.id,
          source: "bank",
          note: "Kohdistettu viitenumerolla",
        });
      } catch (error) {
        // A closed period stops this one payment, not the whole run.
        if (error instanceof PeriodLockedError) {
          skippedLocked.push({
            invoiceId: invoice.id,
            supplierName: invoice.supplierName,
            transactionId: transaction.id,
          });
          consumed.add(transaction.id);
          continue;
        }
        throw error;
      }
      applied.push({
        invoiceId: invoice.id,
        supplierName: invoice.supplierName,
        transactionId: transaction.id,
        amount,
      });
      consumed.add(transaction.id);
      const rest = sharing.filter((candidate) => candidate.id !== invoice.id);
      if (paid >= openCents(invoice)) byReference.set(invoice.reference as string, rest);
      else invoice.payments.push({ amountCents: paid });
    }
  }

  const suggestions = await planPurchaseSuggestions(
    userId,
    openInvoices.filter((invoice) => !applied.some((entry) => entry.invoiceId === invoice.id)),
    outgoing.filter((row) => !consumed.has(row.id))
  );
  return { applied, suggestions, skippedLocked };
}
