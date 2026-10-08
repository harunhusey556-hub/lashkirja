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
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "./db";
import { AppError, NotFoundError, ValidationError } from "./api-errors";
import { centsToEuros, eurosToCents, vatCentsInGrossCents } from "./money";
import { formatDate, formatEur } from "./format";
import { helsinkiCalendarDate, isoDateToUtc } from "./validation";
import { isValidBusinessId, isValidReferenceNumber, normalizeBusinessId, normalizeReference } from "./finnish-reference";
import { isValidIban, normalizeIban } from "./iban";
import { buildAging, displayStatus, openPosition, overdueBefore, type AgingReport } from "./invoices";
import { assertPeriodOpen, PeriodLockedError } from "./period-lock";
import { planPairs } from "./match-gate";
import { rejectedPurchasePairs } from "./purchase-bank-match";
import { isPurchaseVatTreatment, type PurchaseVatTreatment } from "./alv";

export type PurchaseStatus = "open" | "paid" | "cancelled";

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
  const position = openPosition({
    status: invoice.status,
    grossCents: invoice.grossCents,
    paidCents,
    closedReason: invoice.closedReason,
  });
  // An open payable ages exactly like an unpaid sales invoice.
  const derived =
    invoice.status === "open"
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
    open: centsToEuros(position.openCents),
    closedReason: invoice.closedReason,
    category: invoice.category,
    notes: invoice.notes,
    currency: invoice.currency,
    originalAmount: invoice.originalAmountCents == null ? null : centsToEuros(invoice.originalAmountCents),
    vatTreatment: isPurchaseVatTreatment(invoice.vatTreatment) ? invoice.vatTreatment : "domestic",
    paidAt: invoice.paidAt ? invoice.paidAt.toISOString() : null,
    receiptId: invoice.receiptId,
    recurringPurchaseId: invoice.recurringPurchaseId,
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
  return toPublicPurchaseInvoice(updated);
}

export async function deletePurchaseInvoice(userId: string, id: string): Promise<void> {
  const existing = await prisma.purchaseInvoice.findFirst({
    where: { id, userId },
    include: { payments: { select: { id: true } } },
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
  await prisma.purchaseInvoice.delete({ where: { id } });
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
    const openCents = invoice.grossCents - paidBefore;
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

    if (paidBefore + amountCents >= invoice.grossCents && invoice.status === "open") {
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
    select: { id: true, status: true, grossCents: true, closedReason: true },
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
    if ((remaining._sum.amountCents ?? 0) < invoice.grossCents) {
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
    },
  });
  const aging = buildAging(
    open.map((invoice) => {
      const paidCents = invoice.payments.reduce((sum, payment) => sum + payment.amountCents, 0);
      const position = openPosition({
        status: invoice.status,
        grossCents: invoice.grossCents,
        paidCents,
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
  const [open, overdue, paid, cancelled] = await Promise.all([
    prisma.purchaseInvoice.count({
      where: { userId, status: "open", dueDate: { gte: dueBefore } },
    }),
    prisma.purchaseInvoice.count({
      where: { userId, status: "open", dueDate: { lt: dueBefore } },
    }),
    prisma.purchaseInvoice.count({ where: { userId, status: "paid" } }),
    prisma.purchaseInvoice.count({ where: { userId, status: "cancelled" } }),
  ]);
  return { open, overdue, paid, cancelled };
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

type OpenPurchase = Prisma.PurchaseInvoiceGetPayload<{ include: { payments: { select: { amountCents: true } } } }>;
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
    where: { userId, status: "open" },
    include: { payments: { select: { amountCents: true } } },
  });
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
  const paidOf = (invoice: OpenPurchase) => invoice.payments.reduce((sum, payment) => sum + payment.amountCents, 0);
  const plan = planPairs(
    outgoing.map((row) => ({ ...row, amountCents: Math.abs(row.amountCents), counterpartyIban: null })),
    openInvoices.map((invoice) => ({
      id: invoice.id,
      kind: "lasku" as const,
      date: invoice.issueDate,
      dueDate: invoice.dueDate,
      amountCents: invoice.grossCents,
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

  const byReference = new Map(
    openInvoices
      .filter((invoice) => invoice.reference)
      .map((invoice) => [invoice.reference as string, invoice])
  );
  const applied: PurchaseMatchResult["applied"] = [];
  const skippedLocked: PurchaseMatchResult["skippedLocked"] = [];
  const consumed = new Set<string>();

  for (const transaction of outgoing) {
    const candidates = [transaction.reference, transaction.message]
      .filter((value): value is string => Boolean(value))
      .map(normalizeReference);
    const invoice = candidates.map((value) => byReference.get(value)).find(Boolean);
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
    byReference.delete(invoice.reference as string);
  }

  const suggestions = await planPurchaseSuggestions(
    userId,
    openInvoices.filter((invoice) => !applied.some((entry) => entry.invoiceId === invoice.id)),
    outgoing.filter((row) => !consumed.has(row.id))
  );
  return { applied, suggestions, skippedLocked };
}
