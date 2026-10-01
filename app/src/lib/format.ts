/** Shared Finnish formatting so every screen shows money and months alike. */
import { isCentAmount } from "./money";

const eurFormatter = new Intl.NumberFormat("fi-FI", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatEur(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  return eurFormatter.format(value);
}

/** Same as formatEur but always shows the sign, for differences and deltas. */
export function formatEurSigned(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "–";
  const formatted = eurFormatter.format(Math.abs(value));
  if (value === 0) return formatted;
  return `${value > 0 ? "+" : "−"}${formatted}`;
}

const MONTH_NAMES = [
  "tammikuu", "helmikuu", "maaliskuu", "huhtikuu", "toukokuu", "kesäkuu",
  "heinäkuu", "elokuu", "syyskuu", "lokakuu", "marraskuu", "joulukuu",
];

export function formatMonth(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match) return month;
  const name = MONTH_NAMES[Number(match[2]) - 1];
  return name ? `${name} ${match[1]}` : month;
}

/** Compact form for tables: "01/2026". */
export function formatMonthShort(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  return match ? `${match[2]}/${match[1]}` : month;
}

export function formatDate(value: string | null | undefined): string {
  if (!value) return "–";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "–";
  return new Intl.DateTimeFormat("fi-FI", {
    day: "numeric",
    month: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/**
 * Short "d.m." form (no year) for list rows - e.g. list-row due dates. Built
 * from the UTC fields directly rather than through Intl, so the trailing dot
 * and lack of leading zeros don't depend on ICU data for the fi-FI locale.
 */
export function formatDayMonth(value: string | null | undefined): string {
  if (!value) return "–";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "–";
  return `${date.getUTCDate()}.${date.getUTCMonth() + 1}.`;
}

/** "1 kuitti", "0 kuittia", "2 kuittia". */
export function kuittiCount(count: number): string {
  return `${count} ${count === 1 ? "kuitti" : "kuittia"}`;
}

/**
 * Accepts "1 234,56", "1234.56" and a pasted "12,50 €".
 * Empty and junk are null. A leading minus is kept.
 */
export function parseFinnishNumber(value: string): number | null {
  const cleaned = value
    .replace(/€/g, "")
    .replace(/eur/gi, "")
    .replace(/\s| /g, "")
    .replace(",", ".");
  if (!cleaned || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Money typed into a field. Same rules everywhere: comma or dot, optional €,
 * empty is null, more than two decimals or a huge amount is null.
 * A negative amount is returned so the field can explain it; it is still a number.
 */
export function parseMoneyInput(value: string): number | null {
  const parsed = parseFinnishNumber(value);
  if (parsed === null) return null;
  if (!isCentAmount(parsed)) return null;
  return parsed;
}

export function currentMonthKey(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}
