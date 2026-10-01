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

/**
 * The next VAT return actually due for a filer with the given period kind,
 * as of `today`: the earliest period (chronologically) whose statutory due
 * date (`vatDeadline`) falls on or after `today`.
 *
 * `vatDeadline` is monotonic in period order (a later period always has a
 * later or equal due date), so there is exactly one boundary between
 * "already due" and "not yet due" periods. This walks forward from a
 * period safely before that boundary until it crosses it, and returns the
 * first period on or after the crossing - e.g. in September, a monthly
 * filer sees August (due 12 October), not September itself (not yet
 * ended) and not July (due 12 September, already passed).
 */
export function nextDueVatPeriod(today: Date, vatPeriod: VatPeriodKind): VatPeriod {
  const asOf = utcDate(today.getUTCFullYear(), today.getUTCMonth() + 1, today.getUTCDate());

  if (vatPeriod === "year") {
    let year = today.getUTCFullYear() - 3;
    while (vatDeadline({ kind: "year", year }).getTime() < asOf.getTime()) {
      year += 1;
    }
    return { kind: "year", year };
  }

  if (vatPeriod === "quarter") {
    let year = today.getUTCFullYear() - 2;
    let quarter = 1;
    while (vatDeadline({ kind: "quarter", year, quarter }).getTime() < asOf.getTime()) {
      if (quarter === 4) {
        quarter = 1;
        year += 1;
      } else {
        quarter += 1;
      }
    }
    return { kind: "quarter", year, quarter };
  }

  let year = today.getUTCFullYear() - 1;
  let month = 1;
  while (vatDeadline({ kind: "month", year, month }).getTime() < asOf.getTime()) {
    const next = addMonths(year, month, 1);
    year = next.year;
    month = next.month;
  }
  return { kind: "month", year, month };
}

/**
 * FP-4, one deadline rule: every screen that names a VAT deadline goes
 * through `vatDueFor` / `nextVatDue` below. `vatDeadline` itself is called
 * nowhere else in the app (vat-due-rule.test.ts enforces it), so Koti,
 * Kirjanpito, the ALV page and the month close cannot disagree again (TF-01).
 */
export interface VatDue {
  period: VatPeriod;
  /** "2026-08", "2026-Q3" or "2026": the /api/alv `period` and the filing key. */
  key: string;
  /**
   * The key /api/alv and the ALV page's `?period=` take: always the key itself
   * (a yearly filer's year included, F13). Kept as its own field so callers that
   * link or fetch say what they mean.
   */
  queryKey: string;
  /** "Elokuu 2026", "Q3/2026", "2026". */
  label: string;
  /** Statutory due date, already moved off a weekend or holiday (YYYY-MM-DD). */
  dueIso: string;
}

const MONTH_NAMES = [
  "Tammikuu",
  "Helmikuu",
  "Maaliskuu",
  "Huhtikuu",
  "Toukokuu",
  "Kesäkuu",
  "Heinäkuu",
  "Elokuu",
  "Syyskuu",
  "Lokakuu",
  "Marraskuu",
  "Joulukuu",
];

export function vatPeriodKey(period: VatPeriod): string {
  if (period.kind === "month") return `${period.year}-${String(period.month).padStart(2, "0")}`;
  if (period.kind === "quarter") return `${period.year}-Q${period.quarter}`;
  return String(period.year);
}

export function vatDueFor(period: VatPeriod): VatDue {
  const key = vatPeriodKey(period);
  return {
    period,
    key,
    queryKey: key,
    label:
      period.kind === "month"
        ? `${MONTH_NAMES[period.month! - 1]} ${period.year}`
        : period.kind === "quarter"
          ? `Q${period.quarter}/${period.year}`
          : String(period.year),
    dueIso: vatDeadlineIso(period),
  };
}

/** Any stored profile value; unknown strings are monthly, like the rest of the app. */
export function vatPeriodKindOf(value: string | null | undefined): VatPeriodKind {
  return value === "quarter" || value === "year" ? value : "month";
}

/** The next return actually due as of `today` (see nextDueVatPeriod). */
export function nextVatDue(today: Date, kind: VatPeriodKind): VatDue {
  return vatDueFor(nextDueVatPeriod(today, kind));
}

/**
 * The VAT period a calendar month ("YYYY-MM") closes, or null when the month
 * is not the last month of its period (a quarterly filer's July or August).
 */
export function vatPeriodEndingIn(month: string, kind: VatPeriodKind): VatPeriod | null {
  const year = Number(month.slice(0, 4));
  const monthNum = Number(month.slice(5, 7));
  if (kind === "month") return { kind, year, month: monthNum };
  if (kind === "quarter") return monthNum % 3 === 0 ? { kind, year, quarter: monthNum / 3 } : null;
  return monthNum === 12 ? { kind, year } : null;
}
