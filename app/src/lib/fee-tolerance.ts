/**
 * Fee-sized differences between a bank row and a document. Pure (no database),
 * so the client can show the same verdict the server uses.
 */

/** A difference of up to 2 € or 0.5 % of the amount owed counts as a fee. */
export const FEE_TOLERANCE_CENTS = 2_00;
export const FEE_TOLERANCE_RATIO = 0.005;

/**
 * Bank amount minus receipt total when the two disagree by more than a fee
 * (same tolerance as above), or null. A receipt linked to a bank row is booked
 * at its own total, so a gap this size means one of the two is wrong — the
 * link alone must not read as "settled".
 */
export function linkAmountGapCents(bankCents: number, receiptCents: number | null): number | null {
  if (receiptCents == null) return null;
  const paid = Math.abs(bankCents);
  const booked = Math.abs(receiptCents);
  const diff = paid - booked;
  const tolerance = Math.max(FEE_TOLERANCE_CENTS, Math.round(booked * FEE_TOLERANCE_RATIO));
  return Math.abs(diff) > tolerance ? diff : null;
}
