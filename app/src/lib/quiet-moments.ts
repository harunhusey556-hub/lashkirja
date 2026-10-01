/**
 * Three quiet moments: one calm toast sentence the FIRST time something is true for an
 * account. Each rule reads real data (never local storage), so it can never fire twice:
 *
 * - the first invoice that was sent (counted from the invoice status counts),
 * - the first ALV return marked as filed (the server says so: no filing row existed before),
 * - the first month closed (its own screen moment on the month page; no toast here).
 *
 * The success haptic comes from `showToast` itself.
 */

export type SentCounts = { draft: number; sent: number; overdue: number; paid: number; credited: number };

export const FIRST_INVOICE_SENT_TEXT = "Ensimmäinen lasku lähti.";
export const FIRST_VAT_FILED_TEXT = "ALV-ilmoitus on merkitty tehdyksi.";

/**
 * Called right after an invoice went out. The invoice that just left is the only one that is
 * not a draft: sent or overdue, none paid or credited (those could only follow a send).
 */
export function firstInvoiceSentMoment(counts: SentCounts | null | undefined): string | null {
  if (!counts) return null;
  const left = counts.sent + counts.overdue + counts.paid + counts.credited;
  return left === 1 && counts.sent + counts.overdue === 1 ? FIRST_INVOICE_SENT_TEXT : null;
}

/** `firstFiled` is the server's answer to "no ALV filing record existed before this one". */
export function firstVatFiledMoment(firstFiled: boolean | null | undefined): string | null {
  return firstFiled === true ? FIRST_VAT_FILED_TEXT : null;
}
