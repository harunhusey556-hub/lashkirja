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
import { computeInvoiceTotals } from "./invoices";
import type { InvoiceVatSource, ReceiptLike } from "./alv";
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

export async function loadAlvPeriodSources(
  userId: string,
  start: Date,
  end: Date
): Promise<AlvPeriodSources> {
  const [receipts, invoices, payments] = await Promise.all([
    prisma.receipt.findMany({
      where: { userId, date: { gte: start, lt: end }, reviewStatus: "approved" },
      include: { linkedTransaction: { select: { id: true } } },
    }),
    prisma.salesInvoice.findMany({
      where: bookedSalesWhere(userId, start, end),
      include: { lines: true },
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
