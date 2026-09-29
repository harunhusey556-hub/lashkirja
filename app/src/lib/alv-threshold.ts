/**
 * Calendar-year turnover against the 20 000 € VAT registration threshold
 * (AVL 3 §: vähäinen toiminta). The threshold is turnover WITHOUT VAT.
 *
 * Basis, chosen month by month with the same rule the front page uses for one
 * month:
 * - a month that has bank rows (a tiliote assigned to it) counts its incoming
 *   bank rows (kassaperuste);
 * - every other month counts its documents: sales invoices by invoice date and
 *   approved income receipts, with credit notes negative (laskutusperuste).
 *
 * Never both for one month, so nothing counts twice, and a year with a single
 * statement no longer hides the invoices of every month without one.
 */
import { prisma } from "./db";
import { loadAlvPeriodSources } from "./alv-period";
import { buildProfitLoss } from "./reports";

export interface VatThresholdRevenue {
  /** Turnover without VAT, in cents. */
  netCents: number;
  /** Months counted from bank rows, "YYYY-MM". */
  bankMonths: string[];
}

export async function computeYearTurnover(
  userId: string,
  year: number,
  /** Percent, e.g. 25.5; 0 when the business is not VAT registered. */
  defaultSalesRate: number
): Promise<VatThresholdRevenue> {
  const yearPrefix = `${year}-`;
  const rows = await prisma.transaction.findMany({
    where: { statement: { userId, periodMonth: { startsWith: yearPrefix } } },
    select: {
      amountCents: true,
      type: true,
      statement: { select: { periodMonth: true } },
      invoicePayment: {
        select: { invoice: { select: { netCents: true, grossCents: true } } },
      },
    },
  });

  const bankMonths = new Set<string>();
  let bankNetCents = 0;
  for (const row of rows) {
    const month = row.statement.periodMonth;
    if (!month) continue;
    bankMonths.add(month);
    if (row.type !== "tulo") continue;
    const invoice = row.invoicePayment?.invoice;
    if (invoice && invoice.grossCents !== 0) {
      // A row that settled an invoice carries that invoice's VAT share.
      bankNetCents += Math.round((row.amountCents * invoice.netCents) / invoice.grossCents);
    } else if (defaultSalesRate > 0) {
      bankNetCents += Math.round(row.amountCents / (1 + defaultSalesRate / 100));
    } else {
      bankNetCents += row.amountCents;
    }
  }

  const books = await loadAlvPeriodSources(
    userId,
    new Date(Date.UTC(year, 0, 1)),
    new Date(Date.UTC(year + 1, 0, 1))
  );
  const byMonth = buildProfitLoss(books.reportReceipts, books.reportInvoices).months;
  let documentNetCents = 0;
  for (const month of byMonth) {
    if (!month.month || bankMonths.has(month.month)) continue;
    documentNetCents += month.incomeNetCents;
  }

  return {
    netCents: bankNetCents + documentNetCents,
    bankMonths: [...bankMonths].sort(),
  };
}
