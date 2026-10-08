import { z } from "zod";
import { loadLedger } from "./load";
import { balanceSheet, entriesBetween, generalLedger, incomeStatement, numberEntries, trialBalance } from "./reports";
import { ACCOUNTS } from "./chart";

/** A fiscal year: the calendar year (tilikausi = kalenterivuosi in v1). */
export const ledgerYearSchema = z.coerce.number().int().min(2000).max(2100);

export function yearBounds(year: number): { from: string; to: string; end: Date } {
  return { from: `${year}-01-01`, to: `${year + 1}-01-01`, end: new Date(Date.UTC(year + 1, 0, 1)) };
}

/** Everything the Kirjanpito reports show for one fiscal year, from one posting run. */
export async function ledgerYear(userId: string, year: number) {
  const { from, to, end } = yearBounds(year);
  const all = await loadLedger(userId, end);
  const period = entriesBetween(all, from, to);
  const sheet = balanceSheet(all, from, to);
  const suspense = sheet.liabilities.find((line) => line.code === ACCOUNTS.suspense.code)?.cents ?? 0;
  return {
    year,
    from,
    to,
    journal: numberEntries(period),
    trialBalance: trialBalance(period),
    generalLedger: generalLedger(period),
    incomeStatement: incomeStatement(period),
    balanceSheet: sheet,
    notes: {
      // The books start from the first document: no opening balance has been entered yet.
      openingBalanceMissing: true,
      suspenseCents: suspense,
      balances: sheet.assetsCents === sheet.liabilitiesAndEquityCents,
    },
  };
}
