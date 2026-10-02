// Prisma Int is signed 32-bit across connectors. Keep the public range inside it.
export const MAX_MONEY_EUR = 21_474_836.47;

/** Convert a public euro amount to the exact integer-cent representation used in DB. */
export function eurosToCents(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_MONEY_EUR) {
    throw new RangeError("Money amount is outside the supported range");
  }

  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(value * 100 - cents) > 1e-7) {
    throw new RangeError("Money amount must have at most two decimal places");
  }
  return cents;
}

export function centsToEuros(value: number): number {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError("Stored money value is not an integer number of cents");
  }
  return value / 100;
}

export function isCentAmount(value: number): boolean {
  try {
    eurosToCents(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The VAT inside a gross amount at `ratePercent`, in whole cents (integer
 * maths, no float drift). One formula for the receipt form, purchase invoices
 * and recurring purchase templates.
 */
export function vatCentsInGrossCents(grossCents: number, ratePercent: number): number {
  return Math.round((grossCents * ratePercent) / (100 + ratePercent));
}
