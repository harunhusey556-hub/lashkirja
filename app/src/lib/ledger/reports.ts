import { ACCOUNTS_BY_CODE, type AccountType } from "./chart";
import type { JournalEntry } from "./posting";

/**
 * Reports read only journal entries (posting.ts): päiväkirja, pääkirja,
 * saldoluettelo, tuloslaskelma and tase. Amounts are integer cents.
 */

export interface TrialBalanceRow {
  code: string;
  name: string;
  type: AccountType;
  debitCents: number;
  creditCents: number;
  /** Debit minus credit. */
  balanceCents: number;
}

/** The entries of [from, to) — YYYY-MM-DD strings. */
export function entriesBetween(entries: JournalEntry[], from: string, to: string): JournalEntry[] {
  return entries.filter((entry) => entry.date >= from && entry.date < to);
}

/** Voucher numbers in date order: the päiväkirja's running number, per period. */
export function numberEntries(entries: JournalEntry[]): Array<JournalEntry & { voucher: number }> {
  return entries.map((entry, index) => ({ ...entry, voucher: index + 1 }));
}

export function trialBalance(entries: JournalEntry[]): TrialBalanceRow[] {
  const totals = new Map<string, { debit: number; credit: number }>();
  for (const entry of entries) {
    for (const line of entry.lines) {
      const row = totals.get(line.account) ?? { debit: 0, credit: 0 };
      row.debit += line.debitCents;
      row.credit += line.creditCents;
      totals.set(line.account, row);
    }
  }
  return [...totals.entries()]
    .map(([code, { debit, credit }]) => {
      const account = ACCOUNTS_BY_CODE.get(code);
      return {
        code,
        name: account?.name ?? code,
        type: account?.type ?? "expense",
        debitCents: debit,
        creditCents: credit,
        balanceCents: debit - credit,
      };
    })
    .sort((a, b) => a.code.localeCompare(b.code));
}

export interface LedgerAccount {
  code: string;
  name: string;
  lines: Array<{ date: string; entryId: string; description: string; debitCents: number; creditCents: number; runningCents: number }>;
  balanceCents: number;
}

/** Pääkirja: each account's lines in date order with the running balance (debit − credit). */
export function generalLedger(entries: JournalEntry[]): LedgerAccount[] {
  const byAccount = new Map<string, LedgerAccount>();
  for (const entry of entries) {
    for (const line of entry.lines) {
      const account =
        byAccount.get(line.account) ??
        { code: line.account, name: ACCOUNTS_BY_CODE.get(line.account)?.name ?? line.account, lines: [], balanceCents: 0 };
      account.balanceCents += line.debitCents - line.creditCents;
      account.lines.push({
        date: entry.date,
        entryId: entry.id,
        description: entry.description,
        debitCents: line.debitCents,
        creditCents: line.creditCents,
        runningCents: account.balanceCents,
      });
      byAccount.set(line.account, account);
    }
  }
  return [...byAccount.values()].sort((a, b) => a.code.localeCompare(b.code));
}

export interface StatementLine {
  code: string;
  name: string;
  cents: number;
}

export interface IncomeStatement {
  revenue: StatementLine[];
  expenses: StatementLine[];
  revenueCents: number;
  expensesCents: number;
  /** Revenue minus expenses: positive is a profit. */
  resultCents: number;
}

/** Tuloslaskelma of the entries given (one period). Revenue and expenses shown as positive amounts. */
export function incomeStatement(entries: JournalEntry[]): IncomeStatement {
  const rows = trialBalance(entries);
  const revenue = rows.filter((row) => row.type === "revenue").map((row) => ({ code: row.code, name: row.name, cents: -row.balanceCents }));
  const expenses = rows.filter((row) => row.type === "expense").map((row) => ({ code: row.code, name: row.name, cents: row.balanceCents }));
  const revenueCents = revenue.reduce((sum, row) => sum + row.cents, 0);
  const expensesCents = expenses.reduce((sum, row) => sum + row.cents, 0);
  return { revenue, expenses, revenueCents, expensesCents, resultCents: revenueCents - expensesCents };
}

export interface BalanceSheet {
  assets: StatementLine[];
  liabilities: StatementLine[];
  /** Equity accounts plus the results computed from the books (earlier periods, this period). */
  equity: StatementLine[];
  assetsCents: number;
  liabilitiesAndEquityCents: number;
}

/**
 * Tase at the end of the period: every entry up to `to`; the result of the
 * entries before `from` is "Edellisten tilikausien tulos", of [from, to)
 * "Tilikauden tulos". Without an opening balance the books start from zero,
 * so the bank account shows only what was posted (reports say so).
 */
export function balanceSheet(entries: JournalEntry[], from: string, to: string): BalanceSheet {
  const upTo = entries.filter((entry) => entry.date < to);
  const rows = trialBalance(upTo);
  const assets = rows.filter((row) => row.type === "asset").map((row) => ({ code: row.code, name: row.name, cents: row.balanceCents }));
  const liabilities = rows
    .filter((row) => row.type === "liability")
    .map((row) => ({ code: row.code, name: row.name, cents: -row.balanceCents }));
  const equity = rows
    .filter((row) => row.type === "equity")
    .map((row) => ({ code: row.code, name: row.name, cents: -row.balanceCents }));
  const earlier = incomeStatement(upTo.filter((entry) => entry.date < from)).resultCents;
  const current = incomeStatement(entriesBetween(upTo, from, to)).resultCents;
  equity.push({ code: "2250", name: "Edellisten tilikausien voitto (tappio)", cents: earlier });
  equity.push({ code: "2370", name: "Tilikauden voitto (tappio)", cents: current });
  const sum = (lines: StatementLine[]) => lines.reduce((total, line) => total + line.cents, 0);
  return {
    assets,
    liabilities,
    equity,
    assetsCents: sum(assets),
    liabilitiesAndEquityCents: sum(liabilities) + sum(equity),
  };
}
