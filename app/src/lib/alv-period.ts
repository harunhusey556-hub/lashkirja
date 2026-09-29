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
  };
}
