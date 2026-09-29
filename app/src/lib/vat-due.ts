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

/** A refund has nothing to pay: once filed it is done. */
export function vatStateLabel(state: VatFilingState, isRefund: boolean): string {
  if (state === "paid") return "Maksettu";
  if (state === "filed") return isRefund ? "Ilmoitettu" : "Ilmoitettu, maksamatta";
  return "Ilmoittamatta";
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
  if (figures) parts.push(vatStateLabel(vatFilingState(figures.filing), figures.isRefund));
  return parts.join(" · ");
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
