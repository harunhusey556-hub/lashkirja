/**
 * The words every screen uses for a VAT return that is due (FP-4, TF-01).
 *
 * Koti and Kirjanpito render the deadline row through these functions only,
 * from the same `/api/alv` answer (see components/useVatDue.ts), so the two
 * screens show the same period, due date, amount and state by construction.
 */
import { formatDayMonth, formatEur } from "./format";
import type { VatDue } from "./vat-deadline";

export type VatFilingState = "open" | "filed" | "paid";

export interface VatFilingRecord {
  filedAt: string | null;
  paidAt: string | null;
  /** Field 308 at the moment of filing, signed euros (negative = refund). */
  filedAmount: number | null;
}

/** What /api/alv answers for one period, as the deadline row needs it. */
export interface VatDueFigures {
  /** Field 308, unsigned; `isRefund` tells the direction. */
  amount: number;
  isRefund: boolean;
  filing: VatFilingRecord | null;
  /** Pending receipts dated in the period: not in the figure yet (TF-11). */
  pendingReceiptCount: number;
}

export function vatFilingState(filing: VatFilingRecord | null | undefined): VatFilingState {
  if (filing?.paidAt) return "paid";
  if (filing?.filedAt) return "filed";
  return "open";
}

/** A return with nothing to pay (refund or zero) is done once filed. */
export function vatStateLabel(state: VatFilingState, nothingToPay: boolean): string {
  if (state === "paid") return "Maksettu";
  if (state === "filed") return nothingToPay ? "Ilmoitettu" : "Ilmoitettu, maksamatta";
  return "Ilmoittamatta";
}

/**
 * A return with nothing to pay: a refund, or a zero return. Filing it is the whole job, so no payment
 * step is shown and the state never waits for a payment that cannot be made (F73). Once a return is
 * filed, what is owed is what was filed (F66), not what the books say afterwards.
 */
export function vatNothingToPay(figures: { amount: number; isRefund: boolean; filing?: VatFilingRecord | null }): boolean {
  const filed = figures.filing?.filedAt ? figures.filing.filedAmount : null;
  if (filed != null) return filed <= 0;
  return figures.isRefund || figures.amount <= 0;
}

/** A sentence that ends in a date like "12.10." already carries its full stop (F73: no "12.10.."). */
function endSentence(text: string): string {
  return text.endsWith(".") ? text : `${text}.`;
}

/** Step 3 of "Ilmoita ja maksa". */
export function vatFileStepText(dueIso: string): string {
  return endSentence(`Kirjoita kentät tältä sivulta ja lähetä ilmoitus viimeistään ${formatDayMonth(dueIso)}`);
}

/** Step 4; null when there is nothing to pay. */
export function vatPayStepText(amount: number, dueIso: string): string | null {
  if (amount <= 0) return null;
  return endSentence(`Maksa ${formatEur(amount)} viimeistään ${formatDayMonth(dueIso)}`);
}

/** The note under a filed return: when it was filed, and what is still to pay. */
export function vatFiledNote(filedOn: string, amount: number, dueIso: string, nothingToPay: boolean): string {
  const filed = filedOn ? `Ilmoitettu ${filedOn}.` : "Ilmoitettu.";
  const pay = nothingToPay ? null : vatPayStepText(amount, dueIso);
  return pay ? `${filed} ${pay}` : filed;
}

export const VAT_ROW_TITLE = "ALV-ilmoitus";

/**
 * "Elokuu 2026 · eräpäivä 12.10. · Ilmoittamatta". Without figures (a yearly
 * filer, or the amount not loaded) the state is left out rather than guessed.
 */
export function vatDueSecondary(due: VatDue, figures: VatDueFigures | null): string {
  const parts = [due.label];
  if (figures?.isRefund) parts.push("palautus");
  parts.push(`eräpäivä ${formatDayMonth(due.dueIso)}`);
  if (figures) parts.push(vatStateLabel(vatFilingState(figures.filing), vatNothingToPay(figures)));
  // F66: one rule for every screen that shows the row, not only the ALV page.
  if (vatChangedSinceFiling(figures)) parts.push("muuttunut ilmoituksen jälkeen");
  return parts.join(" · ");
}

/** "232,88 €", or "palautus 20,80 €" for a signed refund. */
function signedVatText(signed: number): string {
  return signed < 0 ? `palautus ${formatEur(-signed)}` : formatEur(signed);
}

/**
 * F66: the warning under the row of a return whose figures moved after it was
 * filed (or paid): what was filed, what the books say now. Null when nothing moved.
 */
export function vatChangedNote(figures: VatDueFigures | null): string | null {
  if (!figures || !vatChangedSinceFiling(figures)) return null;
  const filed = figures.filing!.filedAmount!;
  const now = figures.isRefund ? -figures.amount : figures.amount;
  return `Luvut ovat muuttuneet ilmoituksen jälkeen: ilmoitettu ${signedVatText(filed)}, nyt ${signedVatText(now)}.`;
}

/**
 * The amount to pay for a filed return: what was filed, since that is what
 * OmaVero asks for until the return is corrected. An open return pays the live figure.
 */
export function vatAmountToPay(figures: VatDueFigures): number {
  const filedAmount = figures.filing?.filedAmount;
  return figures.filing?.filedAt && filedAmount != null ? Math.max(filedAmount, 0) : figures.amount;
}

/** The amount slot: "159,38 €"; null when there is no figure to show. */
export function vatDueAmount(figures: VatDueFigures | null): string | null {
  return figures ? formatEur(figures.amount) : null;
}

/** TF-11: "2 kuittia odottaa hyväksyntää. Ne voivat muuttaa ALV:tä." */
export function vatPendingNote(figures: VatDueFigures | null): string | null {
  const count = figures?.pendingReceiptCount ?? 0;
  if (count <= 0) return null;
  return count === 1
    ? "1 kuitti odottaa hyväksyntää. Se voi muuttaa ALV:tä."
    : `${count} kuittia odottaa hyväksyntää. Ne voivat muuttaa ALV:tä.`;
}

/** A filed return whose figure no longer matches the books. */
export function vatChangedSinceFiling(figures: VatDueFigures | null): boolean {
  if (!figures?.filing?.filedAt || figures.filing.filedAmount == null) return false;
  const signed = figures.isRefund ? -figures.amount : figures.amount;
  return Math.round(signed * 100) !== Math.round(figures.filing.filedAmount * 100);
}
