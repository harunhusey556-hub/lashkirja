/**
 * When a receipt may be approved (FP-6: a one-tap action carries the same
 * guards as its long path).
 *
 * One rule for every approve path: the Koti pill, the approval sheet, the
 * receipt page, the Kuitit batch and the server. A receipt without an amount
 * cannot be booked: it would enter the VAT return and the books as 0,00 €.
 * The server refuses it; the app shows "Täydennä" instead of "Hyväksy".
 *
 * A missing vendor does not block on the server (a bank-drafted income row
 * can lack one), but the one-tap pill still asks the user to complete it,
 * because a row titled with a file name is not something to approve blind.
 */

export interface ApprovalFields {
  totalAmountCents?: number | null;
  /** Euros, as the client lists carry it. Either field may be given. */
  totalAmount?: number | null;
  vendor?: string | null;
}

export type ApprovalGap = "amount" | "vendor";

function hasAmount(receipt: ApprovalFields): boolean {
  if ("totalAmountCents" in receipt && receipt.totalAmountCents != null) return true;
  if ("totalAmount" in receipt && receipt.totalAmount != null) return true;
  return false;
}

/** What the user must fill in before a one-tap "Hyväksy"; empty = ready. */
export function approvalGaps(receipt: ApprovalFields): ApprovalGap[] {
  const gaps: ApprovalGap[] = [];
  if (!hasAmount(receipt)) gaps.push("amount");
  if (!receipt.vendor || !receipt.vendor.trim()) gaps.push("vendor");
  return gaps;
}

/** The server-side rule: only a missing amount makes approval impossible. */
export function serverApprovalBlock(receipt: ApprovalFields): string | null {
  return hasAmount(receipt) ? null : MISSING_AMOUNT_MESSAGE;
}

export const MISSING_AMOUNT_MESSAGE = "Kuitista puuttuu summa. Lisää summa ennen hyväksyntää.";

/** "Lisää summa ja myyjä" - the one line under a "Täydennä" row. */
export function approvalGapText(gaps: ApprovalGap[]): string {
  if (gaps.includes("amount") && gaps.includes("vendor")) return "Lisää summa ja myyjä";
  if (gaps.includes("amount")) return "Lisää summa";
  if (gaps.includes("vendor")) return "Lisää myyjä";
  return "";
}
