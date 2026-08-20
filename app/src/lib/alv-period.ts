/**
 * Gathers everything a VAT period is computed from, in one place.
 *
 * The VAT report and the dashboard estimate used to collect this separately,
 * which is how they drifted apart. Both now call this, so the number on the
 * front page is the number in the return.
 */
import { prisma } from "./db";
import { centsToEuros } from "./money";
import { computeInvoiceTotals } from "./invoices";
import type { InvoiceVatSource, ReceiptLike } from "./alv";

/** Sales invoices that are part of the books: drafts and credit notes are not. */
export const REPORTED_INVOICE_STATUSES = ["sent", "paid"];

export interface AlvPeriodSources {
  receipts: ReceiptLike[];
  invoices: InvoiceVatSource[];
  receiptCount: number;
  /** Receipts dropped because the same bank row already settled an invoice. */
  excludedReceiptCount: number;
  creditedInvoiceCount: number;
}

export async function loadAlvPeriodSources(
  userId: string,
  start: Date,
  end: Date
): Promise<AlvPeriodSources> {
  const [receipts, invoices, payments, creditedInvoiceCount] = await Promise.all([
    prisma.receipt.findMany({
      where: { userId, date: { gte: start, lt: end }, reviewStatus: "approved" },
      include: { linkedTransaction: { select: { id: true } } },
    }),
    prisma.salesInvoice.findMany({
      where: {
        userId,
        status: { in: REPORTED_INVOICE_STATUSES },
        issueDate: { gte: start, lt: end },
      },
      include: { lines: true },
    }),
    prisma.invoicePayment.findMany({
      where: { invoice: { userId }, transactionId: { not: null } },
      select: { transactionId: true },
    }),
    prisma.salesInvoice.count({
      where: { userId, status: "credited", issueDate: { gte: start, lt: end } },
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

  return {
    receipts: counted.map((receipt) => ({
      type: receipt.type,
      totalAmount:
        receipt.totalAmountCents == null ? null : centsToEuros(receipt.totalAmountCents),
      vatDetails: receipt.vatDetails,
    })),
    invoices: invoices.map((invoice) => ({
      breakdown: computeInvoiceTotals(
        invoice.lines.map((line) => ({
          quantityMilli: line.quantityMilli,
          unitPriceCents: line.unitPriceCents,
          vatRatePermille: line.vatRatePermille,
        }))
      ).breakdown,
    })),
    receiptCount: counted.length,
    excludedReceiptCount: receipts.length - counted.length,
    creditedInvoiceCount,
  };
}
