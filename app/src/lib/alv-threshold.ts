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
  // SQL picks the year's months with bank rows and only the incoming rows with their invoice's
  // net/gross; loading every row of the year with its relations cost ~170 ms of Koti (W18).
  const [months, rows, books] = await Promise.all([
    prisma.$queryRaw<Array<{ periodMonth: string }>>`
      SELECT DISTINCT s."periodMonth" FROM "Statement" s
      WHERE s."userId" = ${userId} AND substr(s."periodMonth", 1, ${yearPrefix.length}) = ${yearPrefix}
        AND EXISTS (SELECT 1 FROM "Transaction" t WHERE t."statementId" = s."id")`,
    prisma.$queryRaw<Array<{ amountCents: number | bigint; netCents: number | bigint | null; grossCents: number | bigint | null }>>`
      SELECT t."amountCents", i."netCents", i."grossCents"
      FROM "Transaction" t
      JOIN "Statement" s ON s."id" = t."statementId"
      LEFT JOIN "InvoicePayment" p ON p."transactionId" = t."id"
      LEFT JOIN "SalesInvoice" i ON i."id" = p."invoiceId"
      WHERE s."userId" = ${userId} AND substr(s."periodMonth", 1, ${yearPrefix.length}) = ${yearPrefix} AND t."type" = 'tulo'`,
    loadAlvPeriodSources(userId, new Date(Date.UTC(year, 0, 1)), new Date(Date.UTC(year + 1, 0, 1))),
  ]);

  const bankMonths = new Set(months.map((row) => row.periodMonth));
  let bankNetCents = 0;
  for (const row of rows) {
    const amountCents = Number(row.amountCents);
    const grossCents = row.grossCents == null ? null : Number(row.grossCents);
    if (grossCents !== null && grossCents !== 0) {
      // A row that settled an invoice carries that invoice's VAT share.
      bankNetCents += Math.round((amountCents * Number(row.netCents)) / grossCents);
    } else if (defaultSalesRate > 0) {
      bankNetCents += Math.round(amountCents / (1 + defaultSalesRate / 100));
    } else {
      bankNetCents += amountCents;
    }
  }

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
