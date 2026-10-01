import { z } from "zod";
import { isCentAmount, MAX_MONEY_EUR } from "./money";

export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
export const alvPeriodSchema = z.string().regex(/^\d{4}-(?:(?:0[1-9]|1[0-2])|Q[1-4])$/);

export const moneySchema = z
  .number()
  .finite()
  .min(-MAX_MONEY_EUR)
  .max(MAX_MONEY_EUR)
  .refine(isCentAmount, "Rahassa saa olla enintään kaksi desimaalia");

export const nonnegativeMoneySchema = moneySchema.nonnegative();

export function isStrictIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export const isoDateSchema = z.string().refine(isStrictIsoDate, "Virheellinen päivä");

export function isoDateToUtc(value: string): Date {
  if (!isStrictIsoDate(value)) throw new RangeError("Invalid ISO calendar date");
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * The calendar date in Europe/Helsinki.
 * Stored invoice dates stay UTC midnights of the day the user picked.
 * "Today" on a new form follows Helsinki, so a minute past local midnight
 * is not still yesterday in UTC.
 */
export function helsinkiCalendarDate(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Helsinki",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/** YYYY-MM in Europe/Helsinki. Defaults for "this month" use this, not the server's zone. */
export function helsinkiMonthKey(now: Date = new Date()): string {
  return helsinkiCalendarDate(now).slice(0, 7);
}

/** YYYY-Q[1-4] in Europe/Helsinki. */
export function helsinkiQuarterKey(now: Date = new Date()): string {
  const [year, monthNumber] = helsinkiCalendarDate(now).split("-").map(Number);
  return `${year}-Q${Math.ceil(monthNumber / 3)}`;
}

export function monthBoundsUtc(month: string): { start: Date; end: Date } {
  const parsed = monthSchema.parse(month);
  const [year, monthNumber] = parsed.split("-").map(Number);
  return {
    start: new Date(Date.UTC(year, monthNumber - 1, 1)),
    end: new Date(Date.UTC(year, monthNumber, 1)),
  };
}

/** A list scope that is one month (YYYY-MM) or a whole year (YYYY): what a report figure links to. */
export const periodScopeSchema = z.string().regex(/^\d{4}(-(0[1-9]|1[0-2]))?$/);

export function periodScopeBoundsUtc(scope: string): { start: Date; end: Date } {
  const parsed = periodScopeSchema.parse(scope);
  if (parsed.length === 4) {
    const year = Number(parsed);
    return { start: new Date(Date.UTC(year, 0, 1)), end: new Date(Date.UTC(year + 1, 0, 1)) };
  }
  return monthBoundsUtc(parsed);
}

export function alvPeriodBoundsUtc(period: string): { start: Date; end: Date } {
  const parsed = alvPeriodSchema.parse(period);
  const quarterMatch = /^(\d{4})-Q([1-4])$/.exec(parsed);
  if (quarterMatch) {
    const year = Number(quarterMatch[1]);
    const quarter = Number(quarterMatch[2]);
    return {
      start: new Date(Date.UTC(year, (quarter - 1) * 3, 1)),
      end: new Date(Date.UTC(year, quarter * 3, 1)),
    };
  }
  return monthBoundsUtc(parsed);
}

