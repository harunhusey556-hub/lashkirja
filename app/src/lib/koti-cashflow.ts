/**
 * OWN-22: income and expenses of the last months for Koti's chart, by the same
 * rule as Koti's "Kuukauden tulos" cards, so the last bar always equals them:
 * a month with tiliote rows is read from the bank (kassaperuste, own transfers
 * left out), any other month from the documents (receipts plus sales
 * invoices, laskutusperuste).
 */
import { prisma } from "./db";
import { Prisma } from "@/generated/prisma/client";
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

  // One grouped sum per month instead of every row of six months (W18: Koti's load time).
  const [rows, books] = await Promise.all([
    prisma.$queryRaw<Array<{ periodMonth: string; incomeCents: number | bigint; expenseCents: number | bigint; count: number | bigint }>>`
      SELECT s."periodMonth",
        SUM(CASE WHEN t."type" = 'tulo' THEN t."amountCents" ELSE 0 END) AS "incomeCents",
        SUM(CASE WHEN t."type" = 'meno' THEN ABS(t."amountCents") ELSE 0 END) AS "expenseCents",
        COUNT(*) AS "count"
      FROM "Transaction" t JOIN "Statement" s ON s."id" = t."statementId"
      WHERE s."userId" = ${userId} AND s."periodMonth" IN (${Prisma.join(window)})
      GROUP BY s."periodMonth"`,
    loadAlvPeriodSources(userId, start, end),
  ]);

  // Same rule as Koti's month: tulo and meno count, oma_siirto is left out.
  const bank = new Map<string, { incomeCents: number; expenseCents: number; count: number }>(
    rows.map((row) => [
      row.periodMonth,
      { incomeCents: Number(row.incomeCents), expenseCents: Number(row.expenseCents), count: Number(row.count) },
    ])
  );

  const documents = new Map<string, { incomeCents: number; expenseCents: number }>();
  for (const period of buildProfitLoss(books.reportReceipts, books.reportInvoices).months) {
    if (!period.month) continue;
    documents.set(period.month, { incomeCents: period.incomeGrossCents, expenseCents: period.expenseGrossCents });
  }

  return combineCashflow(window, bank, documents);
}
