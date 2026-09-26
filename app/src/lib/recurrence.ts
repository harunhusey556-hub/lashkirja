/**
 * Schedule arithmetic for recurring invoices.
 *
 * Two rules decide almost everything here:
 *
 * 1. The anchor day is remembered, not lost. A schedule anchored on the 31st
 *    bills 28 February and then 31 March again - clamping must not silently
 *    walk the schedule backwards to the 28th forever.
 * 2. Missed runs are generated, not skipped. If the app is not opened for
 *    three months, three invoices are owed, each with its own issue date.
 */

export type RecurrenceInterval = "monthly" | "quarterly" | "yearly";

export const RECURRENCE_INTERVALS: RecurrenceInterval[] = [
  "monthly",
  "quarterly",
  "yearly",
];

export const MONTHS_PER_INTERVAL: Record<RecurrenceInterval, number> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

/** A guard, not a business rule: never emit an unbounded catch-up run. */
export const MAX_CATCH_UP_RUNS = 24;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseIsoDate(value: string): { year: number; month: number; day: number } {
  const match = ISO_DATE.exec(value);
  if (!match) throw new RangeError(`Invalid ISO date: ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new RangeError(`Invalid ISO date: ${value}`);
  }
  return { year, month, day };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function toIso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(
    day
  ).padStart(2, "0")}`;
}

/**
 * The date `months` after `from`, keeping the anchor day and clamping only to
 * the length of the target month.
 */
export function addMonthsKeepingAnchor(from: string, months: number, anchorDay: number): string {
  const { year, month } = parseIsoDate(from);
  if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) {
    throw new RangeError(`Invalid anchor day: ${anchorDay}`);
  }
  const total = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(total / 12);
  const targetMonth = total - targetYear * 12 + 1;
  const day = Math.min(anchorDay, daysInMonth(targetYear, targetMonth));
  return toIso(targetYear, targetMonth, day);
}

export interface Schedule {
  interval: RecurrenceInterval;
  /** Day of month the invoice is issued on, 1-31. */
  anchorDay: number;
  /** First issue date, ISO. */
  startDate: string;
  /** Last date the schedule may still produce an invoice, inclusive. */
  endDate?: string | null;
}

export function nextRunAfter(schedule: Schedule, current: string): string {
  return addMonthsKeepingAnchor(
    current,
    MONTHS_PER_INTERVAL[schedule.interval],
    schedule.anchorDay
  );
}

/** The first issue date at or after startDate that sits on the anchor day. */
export function firstRun(schedule: Schedule): string {
  const { year, month, day } = parseIsoDate(schedule.startDate);
  const anchored = Math.min(schedule.anchorDay, daysInMonth(year, month));
  if (anchored >= day) return toIso(year, month, anchored);
  // The anchor has already passed this month, so start next interval.
  return addMonthsKeepingAnchor(
    toIso(year, month, anchored),
    MONTHS_PER_INTERVAL[schedule.interval],
    schedule.anchorDay
  );
}

export interface DueRunsResult {
  /** Issue dates that are owed, oldest first. */
  dates: string[];
  /** Where the schedule stands after these runs; null once it has ended. */
  nextRun: string | null;
  /** True when the cap stopped the catch-up before it was finished. */
  truncated: boolean;
}

/**
 * Every issue date owed up to and including `on`, starting from `nextRun`.
 * An empty list means nothing is due yet - not that the schedule is broken.
 */
export function dueRuns(
  schedule: Schedule,
  nextRun: string,
  on: string,
  maxRuns: number = MAX_CATCH_UP_RUNS
): DueRunsResult {
  parseIsoDate(nextRun);
  parseIsoDate(on);

  const dates: string[] = [];
  let cursor = nextRun;
  let truncated = false;

  while (cursor <= on) {
    if (schedule.endDate && cursor > schedule.endDate) {
      return { dates, nextRun: null, truncated };
    }
    if (dates.length >= maxRuns) {
      truncated = true;
      break;
    }
    dates.push(cursor);
    cursor = nextRunAfter(schedule, cursor);
  }

  if (schedule.endDate && cursor > schedule.endDate) {
    return { dates, nextRun: null, truncated };
  }
  return { dates, nextRun: cursor, truncated };
}

/** Stable key for one occurrence, used to make generation idempotent. */
export function occurrenceKey(issueDate: string): string {
  parseIsoDate(issueDate);
  return issueDate;
}
