/**
 * The statutory due date for a Finnish kausiveroilmoitus (periodic VAT
 * return): the 12th day of the second calendar month after the tax period
 * (or, for a yearly filer, the last day of February the following year) -
 * moved to the next business day when that date falls on a Saturday, a
 * Sunday, or a Finnish public holiday.
 *
 * Pure and deterministic: no `Date.now()`, no locale/timezone dependence
 * (everything is computed in UTC calendar terms, since a due *date* has no
 * time-of-day component to begin with).
 */

export type VatPeriodKind = "month" | "quarter" | "year";

export interface VatPeriod {
  kind: VatPeriodKind;
  /** The tax period's own year (not the deadline's year, which can roll over). */
  year: number;
  /** 1-12, required when kind is "month". */
  month?: number;
  /** 1-4, required when kind is "quarter". */
  quarter?: number;
}

function utcDate(year: number, month1to12: number, day: number): Date {
  return new Date(Date.UTC(year, month1to12 - 1, day));
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function sameDate(a: Date, b: Date): boolean {
  return a.getTime() === b.getTime();
}

/**
 * Easter Sunday (Gregorian calendar), via the standard "Anonymous Gregorian"
 * algorithm (Meeus/Jones/Butcher). Verified against the historical record:
 * 2026-04-05, 2027-03-28, 2004-04-11 (see vat-deadline.test.ts).
 */
export function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const value = h + l - 7 * m + 114;
  const month = Math.floor(value / 31); // 3 = March, 4 = April
  const day = (value % 31) + 1;
  return utcDate(year, month, day);
}

/**
 * Every fixed-date and movable Finnish public holiday in the given calendar
 * year. Movable feasts are derived from Easter Sunday; Midsummer Eve is
 * defined by Finnish law as the Friday falling between 19 and 25 June.
 */
export function finnishHolidays(year: number): Date[] {
  const easter = easterSunday(year);
  const goodFriday = addDays(easter, -2);
  const easterMonday = addDays(easter, 1);
  const ascensionDay = addDays(easter, 39);

  let midsummerEve: Date | null = null;
  for (let day = 19; day <= 25; day += 1) {
    const candidate = utcDate(year, 6, day);
    if (candidate.getUTCDay() === 5) {
      midsummerEve = candidate;
      break;
    }
  }

  return [
    utcDate(year, 1, 1), // Uudenvuodenpäivä
    utcDate(year, 1, 6), // Loppiainen
    goodFriday, // Pitkäperjantai
    easterMonday, // 2. pääsiäispäivä
    utcDate(year, 5, 1), // Vappu
    ascensionDay, // Helatorstai
    ...(midsummerEve ? [midsummerEve] : []), // Juhannusaatto
    utcDate(year, 12, 6), // Itsenäisyyspäivä
    utcDate(year, 12, 24), // Jouluaatto
    utcDate(year, 12, 25), // Joulupäivä
    utcDate(year, 12, 26), // Tapaninpäivä
  ];
}

function isBusinessDay(date: Date): boolean {
  const weekday = date.getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  return !finnishHolidays(date.getUTCFullYear()).some((holiday) => sameDate(holiday, date));
}

function nextBusinessDay(date: Date): Date {
  let candidate = date;
  while (!isBusinessDay(candidate)) {
    candidate = addDays(candidate, 1);
  }
  return candidate;
}

/** month/year with 1-12 rollover, e.g. (11, 2026, +2) -> (1, 2027). */
function addMonths(year: number, month1to12: number, months: number): { year: number; month: number } {
  const total = month1to12 - 1 + months;
  return { year: year + Math.floor(total / 12), month: (((total % 12) + 12) % 12) + 1 };
}

/**
 * The deadline for the given tax period, already rolled forward off a
 * weekend or Finnish public holiday.
 */
export function vatDeadline(period: VatPeriod): Date {
  let base: Date;
  if (period.kind === "month") {
    if (!period.month) throw new Error("vatDeadline: month is required when kind is \"month\"");
    const { year, month } = addMonths(period.year, period.month, 2);
    base = utcDate(year, month, 12);
  } else if (period.kind === "quarter") {
    if (!period.quarter) throw new Error("vatDeadline: quarter is required when kind is \"quarter\"");
    const { year, month } = addMonths(period.year, period.quarter * 3, 2);
    base = utcDate(year, month, 12);
  } else {
    base = utcDate(period.year + 1, 2, 28);
  }
  return nextBusinessDay(base);
}

/** `vatDeadline` as an ISO calendar date (YYYY-MM-DD), for callers that just need to format/compare it. */
export function vatDeadlineIso(period: VatPeriod): string {
  return vatDeadline(period).toISOString().slice(0, 10);
}
