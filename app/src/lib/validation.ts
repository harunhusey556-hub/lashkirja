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

export function monthBoundsUtc(month: string): { start: Date; end: Date } {
  const parsed = monthSchema.parse(month);
  const [year, monthNumber] = parsed.split("-").map(Number);
  return {
    start: new Date(Date.UTC(year, monthNumber - 1, 1)),
    end: new Date(Date.UTC(year, monthNumber, 1)),
  };
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

