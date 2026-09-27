/**
 * One calendar meaning for reports.
 *
 * Booked rows (receipts, invoices, bank booking dates, statement target
 * months) are calendar days stored as UTC midnight. Their month is `monthKey`,
 * which is the YYYY-MM of that UTC day. Every report uses that key.
 *
 * "Today" and the default open period follow Europe/Helsinki via
 * `helsinkiMonthKey`. An instant just after local midnight is already the
 * next Helsinki day, and must not be bucketed with yesterday's UTC date.
 * That difference is intentional: a stored booking date does not move when
 * the viewer changes zone.
 */
import { monthKey } from "./bank-balances";
import { helsinkiMonthKey, isoDateToUtc } from "./validation";

export function statementTargetMonth(bookingDate: string): string {
  return monthKey(isoDateToUtc(bookingDate));
}

export function fallbackStatementMonth(now: Date = new Date()): string {
  return helsinkiMonthKey(now);
}

export function statementMonthOrFallback(bookingDate: string, fallback: string): string {
  try {
    return statementTargetMonth(bookingDate);
  } catch {
    return fallback;
  }
}
