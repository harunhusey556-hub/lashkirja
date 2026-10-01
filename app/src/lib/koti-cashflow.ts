/**
 * OWN-22: income and expenses of the last months for Koti's chart, by the same
 * rule as Koti's "Kuukauden tulos" cards, so the last bar always equals them:
 * a month with tiliote rows is read from the bank (kassaperuste, own transfers
 * left out), any other month from the documents (receipts plus sales
 * invoices, laskutusperuste).
 */
import { prisma } from "./db";
import { addMonths } from "./bank-balances";
import { loadAlvPeriodSources } from "./alv-period";
import { buildProfitLoss } from "./reports";
import { centsToEuros } from "./money";

export interface CashflowMonth {
  month: string;
  income: number;
  expenses: number;
  source: "tiliote" | "kuitit";
}

export function monthWindow(throughMonth: string, months: number): string[] {
  return Array.from({ length: months }, (_, index) => addMonths(throughMonth, index - (months - 1)));
}

/** Pure: combines the per-month bank sums and document sums into the chart rows. */
export function combineCashflow(
  window: readonly string[],
  bank: ReadonlyMap<string, { incomeCents: number; expenseCents: number; count: number }>,
  documents: ReadonlyMap<string, { incomeCents: number; expenseCents: number }>
): CashflowMonth[] {
  return window.map((month) => {
    const fromBank = bank.get(month);
    if (fromBank && fromBank.count > 0) {
      return {
        month,
        income: centsToEuros(fromBank.incomeCents),
        expenses: centsToEuros(fromBank.expenseCents),
        source: "tiliote" as const,
      };
    }
    const fromDocs = documents.get(month);
    return {
      month,
      income: centsToEuros(fromDocs?.incomeCents ?? 0),
      expenses: centsToEuros(fromDocs?.expenseCents ?? 0),
      source: "kuitit" as const,
    };
  });
}

export async function loadCashflow(userId: string, throughMonth: string, months = 6): Promise<CashflowMonth[]> {
  const window = monthWindow(throughMonth, months);
  const [firstYear, firstMonth] = window[0].split("-").map(Number);
  const [lastYear, lastMonth] = throughMonth.split("-").map(Number);
  const start = new Date(Date.UTC(firstYear, firstMonth - 1, 1));
  const end = new Date(Date.UTC(lastYear, lastMonth, 1));

  const [rows, books] = await Promise.all([
    prisma.transaction.findMany({
      where: { statement: { userId, periodMonth: { in: window } } },
      select: { amountCents: true, type: true, statement: { select: { periodMonth: true } } },
    }),
    loadAlvPeriodSources(userId, start, end),
  ]);

  const bank = new Map<string, { incomeCents: number; expenseCents: number; count: number }>();
  for (const row of rows) {
    const month = row.statement?.periodMonth;
    if (!month) continue;
    const entry = bank.get(month) ?? { incomeCents: 0, expenseCents: 0, count: 0 };
    entry.count += 1;
    // Same rule as Koti's month: tulo and meno count, oma_siirto is left out.
    if (row.type === "tulo") entry.incomeCents += row.amountCents;
    else if (row.type === "meno") entry.expenseCents += Math.abs(row.amountCents);
    bank.set(month, entry);
  }

  const documents = new Map<string, { incomeCents: number; expenseCents: number }>();
  for (const period of buildProfitLoss(books.reportReceipts, books.reportInvoices).months) {
    if (!period.month) continue;
    documents.set(period.month, { incomeCents: period.incomeGrossCents, expenseCents: period.expenseGrossCents });
  }

  return combineCashflow(window, bank, documents);
}
