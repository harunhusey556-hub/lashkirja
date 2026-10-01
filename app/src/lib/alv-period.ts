/**
 * Gathers everything a period's books are computed from, in one place.
 *
 * The VAT report, the dashboard, the profit and loss report and the period
 * package used to collect this separately, which is how they drifted apart
 * (the P&L left every sales invoice out). All of them now call this, so the
 * number on the front page is the number in the return and in the report.
 *
 * Basis, the same for every report:
 * - Sales invoices count by their invoice date (laskutusperuste), from the
 *   moment they leave draft. A credited invoice stays in its own period.
 * - A credit note is its own document with negative lines, counted in the
 *   period it was issued (AVL 136 §: a credit reduces the sales of the month
 *   in which it is given). Crediting never rewrites an earlier period.
 * - Approved receipts count by their date.
 * - A purchase invoice's VAT is deductible (field 307) in the period of its
 *   invoice date, once it is recorded (open or paid, never cancelled) (F39).
 *   One purchase must count once: the rule for that is written in
 *   `classifyPurchaseInvoices` below, and only there.
 * - A receipt drafted from, or matched to, a bank row that already settled a
 *   sales invoice is left out: that money is the invoice, not new income.
 * - A payment recorded by hand has no bank row, so the rule above cannot see
 *   it. An income receipt from a bank row with the same amount and a date
 *   near such a payment is most likely the same money: it stays counted (only
 *   evidence removes income) but is flagged, and linking the payment to the
 *   bank row settles it (`findPaymentReceiptDuplicates`).
 */
import { prisma } from "./db";
import { centsToEuros } from "./money";
import { formatReference } from "./finnish-reference";
import { computeInvoiceTotals } from "./invoices";
import { computeAlvReport, parseVatDetails, type AlvReport, type InvoiceVatSource, type PurchaseVatSource, type ReceiptLike } from "./alv";
import type { ReportInvoice, ReportReceipt } from "./reports";

/** Ordinary invoices that are part of the books: sent, paid, or later credited. */
export const REPORTED_INVOICE_STATUSES = ["sent", "paid", "credited"];

export interface AlvPeriodSources {
  receipts: ReceiptLike[];
  invoices: InvoiceVatSource[];
  /** The same counted receipts in the shape the profit and loss report needs. */
  reportReceipts: ReportReceipt[];
  /** The same counted invoices and credit notes, signed, for the P&L. */
  reportInvoices: ReportInvoice[];
  /** F39: purchase invoices whose VAT is deductible in this period, and not already counted through a receipt. */
  purchaseInvoices: PurchaseVatSource[];
  /** Recorded purchase invoices of the period left out because a receipt already counts that purchase. */
  skippedPurchaseInvoiceCount: number;
  /** Counted purchase invoices that look like a receipt that is also counted (same amount, close date). */
  suspectedPurchaseDuplicateCount: number;
  /** Counted purchase invoices whose linked receipt cannot count (no date or no VAT breakdown). */
  purchaseReceiptUnusableCount: number;
  /** Every purchase invoice dated in the period and what the return did with it. */
  purchaseInvoiceRows: PurchaseVatRow[];
  receiptCount: number;
  /** Receipts dropped because the same bank row already settled an invoice. */
  excludedReceiptCount: number;
  /** Ordinary invoices of the period that were later credited (still counted). */
  creditedInvoiceCount: number;
  /** Credit notes issued in the period (counted negative). */
  creditNoteCount: number;
  /**
   * Counted income receipts that look like a hand-recorded invoice payment
   * of the same money. Each one needs the user's decision.
   */
  suspectedDuplicateCount: number;
}

/** Prisma filter for the sales documents that belong to the books of a period. */
export function bookedSalesWhere(userId: string, start: Date, end: Date) {
  return {
    userId,
    issueDate: { gte: start, lt: end },
    OR: [
      { documentKind: "invoice", status: { in: REPORTED_INVOICE_STATUSES } },
      { documentKind: "credit_note", status: { not: "draft" } },
    ],
  };
}

/**
 * The approved receipts of a period and which of them count in the books: a
 * receipt drafted from, or matched to, a bank row that already settled a sales
 * invoice is left out. One place, so the VAT return and the "ALV-erittely
 * puuttuu" exception below can never disagree about which receipts exist.
 */
async function loadCountedReceipts(userId: string, start: Date, end: Date) {
  const [receipts, payments] = await Promise.all([
    prisma.receipt.findMany({
      where: { userId, date: { gte: start, lt: end }, reviewStatus: "approved" },
      include: { linkedTransaction: { select: { id: true } } },
    }),
    prisma.invoicePayment.findMany({
      where: { invoice: { userId }, transactionId: { not: null } },
      select: { transactionId: true },
    }),
  ]);

  // Deduplication on evidence rather than resemblance: a bank row that already
  // settled an invoice must not be counted again through the income receipt
  // drafted from that same row.
  const settledTransactionIds = new Set(
    payments.map((payment) => payment.transactionId).filter((id): id is string => id !== null)
  );
  const counted = receipts.filter((receipt) => {
    if (receipt.sourceTransactionId && settledTransactionIds.has(receipt.sourceTransactionId)) {
      return false;
    }
    return !(receipt.linkedTransaction && settledTransactionIds.has(receipt.linkedTransaction.id));
  });
  return { receipts, counted };
}

/**
 * F72: counted receipts with an amount but no usable VAT breakdown. They are
 * left out of the return (computeAlvReport sends them to `review`), so a
 * VAT-registered owner loses the deduction (or the sales VAT) until the
 * breakdown is added. The month close lists them as an exception.
 */
export async function findReceiptsWithoutVatBreakdown(userId: string, start: Date, end: Date) {
  const { counted } = await loadCountedReceipts(userId, start, end);
  return counted.filter(
    (receipt) =>
      (receipt.type === "meno" || receipt.type === "tulo") &&
      (receipt.totalAmountCents ?? 0) > 0 &&
      parseVatDetails(receipt.vatDetails) === null
  );
}

/** How far apart a purchase invoice's date and a receipt's may be to look like one purchase. */
export const PURCHASE_DUPLICATE_WINDOW_DAYS = 7;

/** What the VAT return did with one purchase invoice, and why (shared with the accountant package). */
export type PurchaseVatTreatment =
  | "counted"
  | "linked_receipt"
  | "bank_receipt"
  | "same_purchase_receipt"
  | "cancelled"
  | "no_vat";

export interface PurchaseVatRow {
  id: string;
  issueDate: Date;
  supplierName: string;
  invoiceNumber: string | null;
  grossCents: number;
  vatCents: number;
  status: string;
  treatment: PurchaseVatTreatment;
  /** Counted, but a receipt of the same amount and a close date may be the same purchase. */
  suspected: boolean;
  /** Counted although a receipt is linked, because that receipt has no date or no VAT breakdown. */
  receiptUnusable: boolean;
}

type PurchaseReceiptEvidence = {
  id: string;
  type: string;
  reviewStatus: string;
  date: Date | null;
  vatDetails: string | null;
  vendor: string | null;
  invoiceNumber: string | null;
  reference: string | null;
  totalAmountCents: number | null;
};

const PURCHASE_RECEIPT_SELECT = {
  id: true,
  type: true,
  reviewStatus: true,
  date: true,
  vatDetails: true,
  vendor: true,
  invoiceNumber: true,
  reference: true,
  totalAmountCents: true,
} as const;

/** A receipt the VAT return actually counts as a purchase: approved, dated, with a usable VAT breakdown. */
function receiptCountsPurchase(receipt: PurchaseReceiptEvidence | null | undefined): boolean {
  return (
    !!receipt &&
    receipt.reviewStatus === "approved" &&
    receipt.type === "meno" &&
    receipt.date !== null &&
    parseVatDetails(receipt.vatDetails) !== null
  );
}

const SUPPLIER_SUFFIX = /\b(oy|oyj|ab|ky|tmi|ltd|gmbh|as)\b\.?/g;
function supplierKey(name: string | null | undefined): string {
  return (name ?? "")
    .toLowerCase()
    .replace(SUPPLIER_SUFFIX, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
function documentKey(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, "").toUpperCase();
}

/**
 * F39, the rule for one purchase counting once, written here and nowhere else.
 * A purchase invoice's VAT is deductible in the period of its invoice date
 * (open or paid; never cancelled). A receipt of the same purchase is what
 * documents it, so the invoice VAT is then left out and the receipt's VAT is
 * the one that counts. "The same purchase" is decided on evidence:
 *  - the receipt is linked to the invoice, or documents the bank row that paid it;
 *  - or the invoice number or the reference is equal;
 *  - or supplier, gross amount and date (within 7 days) are equal.
 * Either way only a receipt the return really counts (approved, dated, VAT
 * breakdown readable) takes the invoice's place; with an unusable receipt the
 * invoice VAT stays in and is flagged. A receipt that only has the same amount
 * and a close date is a resemblance: both are counted and the pair is flagged
 * (`suspected`), never removed. The owner settles it by linking the receipt to
 * the invoice (Ostolaskut), not by rejecting or cancelling anything.
 */
async function classifyPurchaseInvoices(userId: string, start: Date, end: Date): Promise<PurchaseVatRow[]> {
  const invoices = await prisma.purchaseInvoice.findMany({
    where: { userId, issueDate: { gte: start, lt: end } },
    orderBy: [{ issueDate: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      supplierName: true,
      invoiceNumber: true,
      reference: true,
      status: true,
      vatCents: true,
      grossCents: true,
      issueDate: true,
      receipt: { select: PURCHASE_RECEIPT_SELECT },
      payments: { select: { transactionId: true } },
    },
  });
  if (invoices.length === 0) return [];

  const rowIds = invoices.flatMap((invoice) =>
    invoice.payments.map((payment) => payment.transactionId).filter((id): id is string => id !== null)
  );
  const documentedRows = new Set(
    rowIds.length === 0
      ? []
      : (
          await prisma.transaction.findMany({
            where: { id: { in: rowIds }, receipt: { is: { reviewStatus: "approved" } } },
            select: { id: true, receipt: { select: PURCHASE_RECEIPT_SELECT } },
          })
        )
          .filter((row) => receiptCountsPurchase(row.receipt))
          .map((row) => row.id)
  );

  const rows = new Map<string, PurchaseVatRow>();
  const undecided: typeof invoices = [];
  for (const invoice of invoices) {
    const row: PurchaseVatRow = {
      id: invoice.id,
      issueDate: invoice.issueDate,
      supplierName: invoice.supplierName,
      invoiceNumber: invoice.invoiceNumber,
      grossCents: invoice.grossCents,
      vatCents: invoice.vatCents,
      status: invoice.status,
      treatment: "counted",
      suspected: false,
      receiptUnusable: false,
    };
    rows.set(invoice.id, row);
    if (invoice.status !== "open" && invoice.status !== "paid") row.treatment = "cancelled";
    else if (invoice.vatCents <= 0) row.treatment = "no_vat";
    else if (receiptCountsPurchase(invoice.receipt)) row.treatment = "linked_receipt";
    else if (invoice.payments.some((payment) => payment.transactionId !== null && documentedRows.has(payment.transactionId))) {
      row.treatment = "bank_receipt";
    } else {
      // An approved receipt the return cannot use does not replace the invoice.
      row.receiptUnusable = invoice.receipt?.reviewStatus === "approved";
      undecided.push(invoice);
    }
  }
  if (undecided.length === 0) return invoices.map((invoice) => rows.get(invoice.id)!);

  const window = PURCHASE_DUPLICATE_WINDOW_DAYS * DAY_MS;
  const times = undecided.map((invoice) => invoice.issueDate.getTime());
  const numbers = [...new Set(undecided.map((invoice) => invoice.invoiceNumber?.trim()).filter((n): n is string => !!n))];
  // A receipt keeps a reference as printed ("12345 67890"), an invoice normalized.
  const references = [
    ...new Set(
      undecided
        .map((invoice) => invoice.reference?.trim())
        .filter((n): n is string => !!n)
        .flatMap((reference) => [reference, formatReference(reference)])
    ),
  ];
  const candidates = (
    await prisma.receipt.findMany({
      where: {
        userId,
        type: "meno",
        reviewStatus: "approved",
        date: { not: null },
        // A receipt linked to a purchase invoice documents that invoice only.
        purchaseInvoice: { is: null },
        OR: [
          {
            totalAmountCents: { in: [...new Set(undecided.map((invoice) => invoice.grossCents))] },
            date: { gte: new Date(Math.min(...times) - window), lte: new Date(Math.max(...times) + window) },
          },
          ...(numbers.length > 0 ? [{ invoiceNumber: { in: numbers } }] : []),
          ...(references.length > 0 ? [{ reference: { in: references } }] : []),
        ],
      },
      select: PURCHASE_RECEIPT_SELECT,
    })
  ).filter(receiptCountsPurchase);

  const used = new Set<string>();
  const near = (receipt: PurchaseReceiptEvidence, invoice: (typeof invoices)[number]) =>
    Math.abs(receipt.date!.getTime() - invoice.issueDate.getTime()) <= window;
  const sameAmount = (receipt: PurchaseReceiptEvidence, invoice: (typeof invoices)[number]) =>
    receipt.totalAmountCents === invoice.grossCents;
  const strong = (receipt: PurchaseReceiptEvidence, invoice: (typeof invoices)[number]) =>
    (documentKey(invoice.invoiceNumber) !== "" && documentKey(receipt.invoiceNumber) === documentKey(invoice.invoiceNumber)) ||
    (documentKey(invoice.reference) !== "" && documentKey(receipt.reference) === documentKey(invoice.reference)) ||
    (sameAmount(receipt, invoice) &&
      near(receipt, invoice) &&
      supplierKey(invoice.supplierName) !== "" &&
      supplierKey(receipt.vendor) === supplierKey(invoice.supplierName));

  for (const invoice of undecided) {
    const match = candidates.find((receipt) => !used.has(receipt.id) && strong(receipt, invoice));
    if (!match) continue;
    used.add(match.id);
    const row = rows.get(invoice.id)!;
    row.treatment = "same_purchase_receipt";
    row.receiptUnusable = false;
  }
  for (const invoice of undecided) {
    const row = rows.get(invoice.id)!;
    if (row.treatment !== "counted") continue;
    const match = candidates.find((receipt) => !used.has(receipt.id) && sameAmount(receipt, invoice) && near(receipt, invoice));
    if (match) {
      used.add(match.id);
      row.suspected = true;
    }
  }
  return invoices.map((invoice) => rows.get(invoice.id)!);
}

/**
 * F39: the purchase invoices of the period with what the return did with each.
 * Used by the VAT return and by the accountant package, so the two agree.
 */
async function loadPurchaseVat(userId: string, start: Date, end: Date) {
  const rows = await classifyPurchaseInvoices(userId, start, end);
  const counted = rows.filter((row) => row.treatment === "counted");
  return {
    rows,
    counted: counted.map((row): PurchaseVatSource => ({ vatCents: row.vatCents })),
    skipped: rows.filter(
      (row) => row.treatment === "linked_receipt" || row.treatment === "bank_receipt" || row.treatment === "same_purchase_receipt"
    ).length,
    suspected: counted.filter((row) => row.suspected).length,
    receiptUnusable: counted.filter((row) => row.receiptUnusable).length,
  };
}

export async function loadAlvPeriodSources(
  userId: string,
  start: Date,
  end: Date
): Promise<AlvPeriodSources> {
  const [{ receipts, counted }, invoices, purchases] = await Promise.all([
    loadCountedReceipts(userId, start, end),
    prisma.salesInvoice.findMany({
      where: bookedSalesWhere(userId, start, end),
      include: { lines: true },
    }),
    loadPurchaseVat(userId, start, end),
  ]);

  const bookedInvoices = invoices.map((invoice) => {
    // Totals from the lines, exactly as the VAT return reads them. A credit
    // note's lines carry negative prices, so its totals come out negative.
    const totals = computeInvoiceTotals(
      invoice.lines.map((line) => ({
        quantityMilli: line.quantityMilli,
        unitPriceCents: line.unitPriceCents,
        vatRatePermille: line.vatRatePermille,
      }))
    );
    return { invoice, totals };
  });

  return {
    receipts: counted.map((receipt) => ({
      type: receipt.type,
      totalAmount:
        receipt.totalAmountCents == null ? null : centsToEuros(receipt.totalAmountCents),
      vatDetails: receipt.vatDetails,
    })),
    invoices: bookedInvoices.map(({ totals }) => ({ breakdown: totals.breakdown })),
    reportReceipts: counted.map((receipt) => ({
      type: receipt.type,
      date: receipt.date,
      totalAmountCents: receipt.totalAmountCents,
      category: receipt.category,
      vatDetails: receipt.vatDetails,
    })),
    reportInvoices: bookedInvoices.map(({ invoice, totals }) => ({
      issueDate: invoice.issueDate,
      documentKind: invoice.documentKind === "credit_note" ? "credit_note" : "invoice",
      netCents: totals.netCents,
      vatCents: totals.vatCents,
      grossCents: totals.grossCents,
    })),
    purchaseInvoices: purchases.counted,
    skippedPurchaseInvoiceCount: purchases.skipped,
    suspectedPurchaseDuplicateCount: purchases.suspected,
    purchaseReceiptUnusableCount: purchases.receiptUnusable,
    purchaseInvoiceRows: purchases.rows,
    receiptCount: counted.length,
    excludedReceiptCount: receipts.length - counted.length,
    creditedInvoiceCount: invoices.filter(
      (invoice) => invoice.documentKind === "invoice" && invoice.status === "credited"
    ).length,
    creditNoteCount: invoices.filter((invoice) => invoice.documentKind === "credit_note").length,
    suspectedDuplicateCount: (
      await findPaymentReceiptDuplicates(userId, {
        receiptIds: counted.filter((receipt) => receipt.type === "tulo").map((receipt) => receipt.id),
      })
    ).length,
  };
}

/** The VAT return of a period from its sources: the one place that feeds computeAlvReport (F39). */
export function alvReportOf(sources: Pick<AlvPeriodSources, "receipts" | "invoices" | "purchaseInvoices">): AlvReport {
  return computeAlvReport(sources.receipts, sources.invoices, sources.purchaseInvoices);
}

/** How far apart a hand-entered payment date and the bank row may be. */
export const DUPLICATE_DATE_WINDOW_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Marks a flagged pair as two separate incomes, so it is not raised again. */
export const DUPLICATE_DISMISSED_KIND = "payment_duplicate_dismissed";

export interface PaymentReceiptDuplicate {
  receiptId: string;
  receiptVendor: string | null;
  receiptDate: string | null;
  amountCents: number;
  /** The bank row the receipt came from; linking the payment to it resolves the pair. */
  transactionId: string;
  paymentId: string;
  paidDate: string;
  invoiceId: string;
  invoiceNumber: number;
  customerName: string;
}

/**
 * Pairs an approved income receipt that came from a bank row with an invoice
 * payment recorded by hand (no bank row) of the same amount within a few days.
 * Each payment and each receipt is used at most once, closest dates first.
 */
export async function findPaymentReceiptDuplicates(
  userId: string,
  filter: { receiptIds?: string[]; invoiceId?: string } = {}
): Promise<PaymentReceiptDuplicate[]> {
  if (filter.receiptIds && filter.receiptIds.length === 0) return [];
  const payments = await prisma.invoicePayment.findMany({
    where: {
      invoice: { userId, ...(filter.invoiceId ? { id: filter.invoiceId } : {}) },
      transactionId: null,
      amountCents: { gt: 0 },
    },
    select: {
      id: true,
      amountCents: true,
      paidDate: true,
      invoice: { select: { id: true, number: true, customer: { select: { name: true } } } },
    },
  });
  if (payments.length === 0) return [];

  const receipts = await prisma.receipt.findMany({
    where: {
      userId,
      type: "tulo",
      reviewStatus: "approved",
      date: { not: null },
      totalAmountCents: { in: [...new Set(payments.map((payment) => payment.amountCents))] },
      OR: [{ sourceTransactionId: { not: null } }, { linkedTransaction: { isNot: null } }],
      ...(filter.receiptIds ? { id: { in: filter.receiptIds } } : {}),
    },
    select: {
      id: true,
      vendor: true,
      date: true,
      totalAmountCents: true,
      sourceTransactionId: true,
      linkedTransaction: { select: { id: true } },
    },
  });
  if (receipts.length === 0) return [];

  const rowIds = receipts.map((receipt) => receipt.linkedTransaction?.id ?? receipt.sourceTransactionId!);
  const [rows, dismissed] = await Promise.all([
    prisma.transaction.findMany({
      where: { id: { in: rowIds }, statement: { userId } },
      select: { id: true, invoicePayment: { select: { id: true } } },
    }),
    prisma.automationEvent.findMany({
      where: {
        userId,
        kind: DUPLICATE_DISMISSED_KIND,
        resourceType: "receipt",
        resourceId: { in: receipts.map((receipt) => receipt.id) },
      },
      select: { resourceId: true, newValue: true },
    }),
  ]);
  // Only a live bank row that settles nothing yet can be linked; a row that
  // already settled an invoice is deduplicated by the evidence rule instead.
  const linkable = new Set(rows.filter((row) => !row.invoicePayment).map((row) => row.id));
  const dismissedPairs = new Set(dismissed.map((event) => `${event.resourceId}:${event.newValue}`));

  const candidates: Array<{ gap: number; receipt: (typeof receipts)[number]; rowId: string; payment: (typeof payments)[number] }> = [];
  for (const receipt of receipts) {
    const rowId = receipt.linkedTransaction?.id ?? receipt.sourceTransactionId!;
    if (!linkable.has(rowId) || !receipt.date) continue;
    for (const payment of payments) {
      if (payment.amountCents !== receipt.totalAmountCents) continue;
      if (dismissedPairs.has(`${receipt.id}:${payment.id}`)) continue;
      const gap = Math.abs(payment.paidDate.getTime() - receipt.date.getTime());
      if (gap > DUPLICATE_DATE_WINDOW_DAYS * DAY_MS) continue;
      candidates.push({ gap, receipt, rowId, payment });
    }
  }
  candidates.sort((a, b) => a.gap - b.gap);

  const usedReceipts = new Set<string>();
  const usedPayments = new Set<string>();
  const pairs: PaymentReceiptDuplicate[] = [];
  for (const { receipt, rowId, payment } of candidates) {
    if (usedReceipts.has(receipt.id) || usedPayments.has(payment.id)) continue;
    usedReceipts.add(receipt.id);
    usedPayments.add(payment.id);
    pairs.push({
      receiptId: receipt.id,
      receiptVendor: receipt.vendor,
      receiptDate: receipt.date ? receipt.date.toISOString().slice(0, 10) : null,
      amountCents: payment.amountCents,
      transactionId: rowId,
      paymentId: payment.id,
      paidDate: payment.paidDate.toISOString().slice(0, 10),
      invoiceId: payment.invoice.id,
      invoiceNumber: payment.invoice.number,
      customerName: payment.invoice.customer.name,
    });
  }
  return pairs;
}
