/**
 * Late payment interest (viivästyskorko) and reminder fees.
 *
 * The rate is not hard-coded. Finnish late interest is the Bank of Finland
 * reference rate plus a statutory margin, and that reference rate changes
 * every six months - a number baked in here would be quietly wrong half the
 * time. The user stores the rate they are entitled to charge, and nothing is
 * charged until they do.
 *
 * Interest runs from the day after the due date, on actual days over a
 * 365-day year, which is how a Finnish invoice states it.
 */

export const DAY_MS = 86_400_000;
export const INTEREST_YEAR_DAYS = 365;

/** Statutory margins over the reference rate, for the user's own reference. */
export const STATUTORY_MARGIN = {
  /** Korkolaki 4 §: consumer debts. */
  consumer: 7,
  /** Korkolaki 4 a §: business-to-business debts. */
  commercial: 8,
} as const;

function toUtcDay(value: Date | string): number {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError(`Invalid date: ${String(value)}`);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** Whole days of delay; the due date itself is still on time. */
export function daysLate(dueDate: Date | string, on: Date | string): number {
  const days = Math.floor((toUtcDay(on) - toUtcDay(dueDate)) / DAY_MS);
  return days > 0 ? days : 0;
}

export interface InterestInput {
  openCents: number;
  dueDate: Date | string;
  on: Date | string;
  /** Annual percentage, e.g. 11.5. Zero or missing means no interest. */
  annualRatePercent: number | null | undefined;
}

export interface InterestResult {
  days: number;
  interestCents: number;
  annualRatePercent: number;
}

export function computeLateInterest(input: InterestInput): InterestResult {
  const rate = input.annualRatePercent ?? 0;
  const days = daysLate(input.dueDate, input.on);

  if (!Number.isFinite(rate) || rate <= 0 || days === 0 || input.openCents <= 0) {
    return { days, interestCents: 0, annualRatePercent: rate > 0 ? rate : 0 };
  }

  const interest = (input.openCents * rate * days) / (100 * INTEREST_YEAR_DAYS);
  return {
    days,
    // Round to whole cents; a fraction of a cent is not collectable.
    interestCents: Math.round(interest),
    annualRatePercent: rate,
  };
}

export interface ReminderTotals {
  openCents: number;
  interestCents: number;
  feeCents: number;
  totalCents: number;
  days: number;
  annualRatePercent: number;
}

/**
 * What a reminder asks for: the unpaid principal, the interest accrued so far
 * and the reminder fee. The fee is a separate line because it is not part of
 * the original sale and carries no VAT.
 */
export function buildReminderTotals(input: InterestInput & { feeCents: number }): ReminderTotals {
  if (input.feeCents < 0) throw new RangeError("Reminder fee cannot be negative");
  const interest = computeLateInterest(input);
  const openCents = Math.max(0, input.openCents);
  return {
    openCents,
    interestCents: interest.interestCents,
    feeCents: input.feeCents,
    totalCents: openCents + interest.interestCents + input.feeCents,
    days: interest.days,
    annualRatePercent: interest.annualRatePercent,
  };
}
