/**
 * Month-end balance rollforward and reconciliation for a single bank account.
 *
 * The engine is deliberately pure: it takes an opening balance, the account's
 * transactions and whatever closing balances the bank itself reported, and
 * returns one row per month. No database access, so every rule below is
 * directly testable.
 *
 * Two closing balances exist per month and they are never merged:
 *   - computed  = opening + net movement of the month (what our books say)
 *   - reported  = what the bank says the account held at month end
 * Their difference is the reconciliation signal. Hiding it would defeat the
 * purpose, so a mismatch stays visible until the user resolves it.
 */

export const MAX_ROLLFORWARD_MONTHS = 600; // 50 years; a guard, not a business rule

export interface BalanceTransactionInput {
  /** Statement row date. Null when the source file had no parsable date. */
  date: Date | string | null;
  /** Signed: negative is money out. */
  amountCents: number;
}

export interface ReportedBalanceInput {
  month: string; // "YYYY-MM"
  closingBalanceCents: number;
  source?: string;
}

export interface RollforwardAccount {
  openingBalanceCents: number;
  /** The balance above is the balance at the START of this day. */
  openingDate: Date | string;
}

export type MonthStatus = "reconciled" | "mismatch" | "unreported";
export type OpeningSource = "opening_balance" | "reported" | "computed";

export interface MonthlyBalanceRow {
  month: string;
  openingCents: number;
  openingSource: OpeningSource;
  incomeCents: number;
  /** Positive magnitude of money out. */
  expenseCents: number;
  netCents: number;
  txCount: number;
  computedClosingCents: number;
  reportedClosingCents: number | null;
  /** reported - computed. Positive: bank holds more than the books explain. */
  differenceCents: number | null;
  status: MonthStatus;
}

export interface RollforwardResult {
  months: MonthlyBalanceRow[];
  /** Closing balance of the last month in range; the account's current position. */
  currentBalanceCents: number;
  lastReconciledMonth: string | null;
  mismatchMonths: string[];
  unreportedMonths: string[];
  excluded: {
    undatedTxCount: number;
    preOpeningTxCount: number;
    preOpeningAmountCents: number;
    outOfRangeReportedMonths: string[];
  };
}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isMonthKey(value: string): boolean {
  return MONTH_PATTERN.test(value);
}

export function toDate(value: Date | string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError(`Invalid date: ${String(value)}`);
  return date;
}

/** Month key in UTC. Dates are stored as UTC midnight, so UTC keeps the day stable. */
export function monthKey(value: Date | string): string {
  const date = toDate(value);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function addMonths(month: string, delta: number): string {
  if (!isMonthKey(month)) throw new RangeError(`Invalid month key: ${month}`);
  const [year, monthNumber] = month.split("-").map(Number);
  const total = year * 12 + (monthNumber - 1) + delta;
  const nextYear = Math.floor(total / 12);
  const nextMonth = total - nextYear * 12;
  return `${String(nextYear).padStart(4, "0")}-${String(nextMonth + 1).padStart(2, "0")}`;
}

export function compareMonths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function monthRange(from: string, to: string): string[] {
  if (compareMonths(from, to) > 0) return [];
  const months: string[] = [];
  let cursor = from;
  while (compareMonths(cursor, to) <= 0) {
    months.push(cursor);
    if (months.length >= MAX_ROLLFORWARD_MONTHS) break;
    cursor = addMonths(cursor, 1);
  }
  return months;
}

/** The last day covered by a month key, as a UTC timestamp. */
function monthEndUtc(month: string): Date {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber, 0, 23, 59, 59, 999));
}

export interface RollforwardOptions {
  /** Extend the table up to this month even when nothing happened. */
  throughMonth?: string;
}

export function buildRollforward(
  account: RollforwardAccount,
  transactions: BalanceTransactionInput[],
  reportedBalances: ReportedBalanceInput[] = [],
  options: RollforwardOptions = {}
): RollforwardResult {
  const openingDate = toDate(account.openingDate);
  const openingMonth = monthKey(openingDate);

  const excluded = {
    undatedTxCount: 0,
    preOpeningTxCount: 0,
    preOpeningAmountCents: 0,
    outOfRangeReportedMonths: [] as string[],
  };

  // Bucket transactions per month, dropping the ones the account cannot own.
  const movements = new Map<
    string,
    { income: number; expense: number; net: number; count: number }
  >();
  let lastTxMonth: string | null = null;

  for (const tx of transactions) {
    if (tx.date === null || tx.date === undefined || tx.date === "") {
      excluded.undatedTxCount += 1;
      continue;
    }
    const date = toDate(tx.date);
    if (date.getTime() < openingDate.getTime()) {
      excluded.preOpeningTxCount += 1;
      excluded.preOpeningAmountCents += tx.amountCents;
      continue;
    }
    const month = monthKey(date);
    const bucket = movements.get(month) ?? { income: 0, expense: 0, net: 0, count: 0 };
    if (tx.amountCents >= 0) bucket.income += tx.amountCents;
    else bucket.expense += -tx.amountCents;
    bucket.net += tx.amountCents;
    bucket.count += 1;
    movements.set(month, bucket);
    if (!lastTxMonth || compareMonths(month, lastTxMonth) > 0) lastTxMonth = month;
  }

  // Reported balances, keyed by month. A later entry for the same month wins.
  const reported = new Map<string, number>();
  let lastReportedMonth: string | null = null;
  for (const entry of reportedBalances) {
    if (!isMonthKey(entry.month)) {
      excluded.outOfRangeReportedMonths.push(entry.month);
      continue;
    }
    if (compareMonths(entry.month, openingMonth) < 0) {
      excluded.outOfRangeReportedMonths.push(entry.month);
      continue;
    }
    reported.set(entry.month, entry.closingBalanceCents);
    if (!lastReportedMonth || compareMonths(entry.month, lastReportedMonth) > 0) {
      lastReportedMonth = entry.month;
    }
  }

  let lastMonth = openingMonth;
  for (const candidate of [lastTxMonth, lastReportedMonth, options.throughMonth]) {
    if (candidate && isMonthKey(candidate) && compareMonths(candidate, lastMonth) > 0) {
      lastMonth = candidate;
    }
  }

  const months: MonthlyBalanceRow[] = [];
  let opening = account.openingBalanceCents;
  let openingSource: OpeningSource = "opening_balance";
  let lastReconciledMonth: string | null = null;
  const mismatchMonths: string[] = [];
  const unreportedMonths: string[] = [];

  for (const month of monthRange(openingMonth, lastMonth)) {
    const movement = movements.get(month) ?? { income: 0, expense: 0, net: 0, count: 0 };
    const computedClosing = opening + movement.net;
    const reportedClosing = reported.has(month) ? reported.get(month)! : null;
    const difference = reportedClosing === null ? null : reportedClosing - computedClosing;
    const status: MonthStatus =
      reportedClosing === null ? "unreported" : difference === 0 ? "reconciled" : "mismatch";

    months.push({
      month,
      openingCents: opening,
      openingSource,
      incomeCents: movement.income,
      expenseCents: movement.expense,
      netCents: movement.net,
      txCount: movement.count,
      computedClosingCents: computedClosing,
      reportedClosingCents: reportedClosing,
      differenceCents: difference,
      status,
    });

    if (status === "reconciled") lastReconciledMonth = month;
    else if (status === "mismatch") mismatchMonths.push(month);
    else unreportedMonths.push(month);

    // The bank is the authority: anchor the next month on the reported figure
    // when there is one, so a single unexplained month does not shift every
    // later balance.
    if (reportedClosing !== null) {
      opening = reportedClosing;
      openingSource = "reported";
    } else {
      opening = computedClosing;
      openingSource = "computed";
    }
  }

  const last = months[months.length - 1];
  return {
    months,
    currentBalanceCents: last
      ? last.reportedClosingCents ?? last.computedClosingCents
      : account.openingBalanceCents,
    lastReconciledMonth,
    mismatchMonths,
    unreportedMonths,
    excluded,
  };
}

/** Balance of the account at the end of `month` (reported wins over computed). */
export function balanceAtMonthEnd(result: RollforwardResult, month: string): number | null {
  const row = result.months.find((entry) => entry.month === month);
  if (!row) return null;
  return row.reportedClosingCents ?? row.computedClosingCents;
}

export interface AccountPosition {
  bankAccountId: string;
  name: string;
  currency: string;
  balanceCents: number;
  status: MonthStatus | "no_data";
}

/** Combined position across accounts. Only same-currency accounts are summed. */
export function totalPosition(
  positions: AccountPosition[],
  currency = "EUR"
): { totalCents: number; includedAccounts: number; excludedCurrencies: string[] } {
  let totalCents = 0;
  let includedAccounts = 0;
  const excludedCurrencies = new Set<string>();
  for (const position of positions) {
    if (position.currency !== currency) {
      excludedCurrencies.add(position.currency);
      continue;
    }
    totalCents += position.balanceCents;
    includedAccounts += 1;
  }
  return {
    totalCents,
    includedAccounts,
    excludedCurrencies: [...excludedCurrencies].sort(),
  };
}

export { monthEndUtc };
