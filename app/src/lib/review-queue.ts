/**
 * Pure rules of the Kuitit review queue (F15). The queue follows the one
 * approval rule of receipt-approval.ts, the same one Koti and the server use:
 * a receipt that lacks an amount or a vendor shows "Täydennä", never "Hyväksy",
 * and the bulk approval only carries the receipts that are ready.
 */
import { approvalGaps, MISSING_AMOUNT_MESSAGE, type ApprovalGap } from "./receipt-approval";

interface QueueRow {
  id: string;
  vendor: string | null;
  totalAmount: number | null;
}

export function splitApprovable<T extends QueueRow>(
  receipts: T[]
): { ready: T[]; incomplete: Array<T & { gaps: ApprovalGap[] }> } {
  const ready: T[] = [];
  const incomplete: Array<T & { gaps: ApprovalGap[] }> = [];
  for (const receipt of receipts) {
    const gaps = approvalGaps({ totalAmount: receipt.totalAmount, vendor: receipt.vendor });
    if (gaps.length === 0) ready.push(receipt);
    else incomplete.push({ ...receipt, gaps });
  }
  return { ready, incomplete };
}

/** "Yhteensä 12,50 €"; receipts without a total are counted, never added as 0,00 €. */
export function queueTotalText(
  receipts: Array<Pick<QueueRow, "totalAmount">>,
  format: (value: number) => string
): string {
  const known = receipts.filter((receipt) => receipt.totalAmount != null);
  if (known.length === 0) return "Yhteensä –";
  const sum = known.reduce((total, receipt) => total + (receipt.totalAmount ?? 0), 0);
  const unknown = receipts.length - known.length;
  return unknown > 0
    ? `Yhteensä ${format(sum)} + ${unknown} ilman summaa`
    : `Yhteensä ${format(sum)}`;
}

export interface ApprovalFailure {
  id: string;
  error: string;
}

/** What the bulk approval answers: the refusal itself, not just "epäonnistui N". */
export function approvalFailureText(approved: number, failed: ApprovalFailure[]): string {
  if (failed.length === 0) return `Hyväksyttiin ${approved}.`;
  const reasons = [...new Set(failed.map((item) => item.error).filter(Boolean))];
  const head = failed.length === 1 ? "Yhtä kuittia" : `${failed.length} kuittia`;
  const refused = `${head} ei voitu hyväksyä${reasons.length > 0 ? `: ${reasons.join(" ")}` : "."}`;
  return approved > 0 ? `Hyväksyttiin ${approved}. ${refused}` : refused;
}

/** How the outcome of a bulk action is shown. Decided from the count of failures, never from the message text. */
export type NoticeTone = "success" | "error";

export function noticeToneFor(failedCount: number): NoticeTone {
  return failedCount > 0 ? "error" : "success";
}

/** Refusals the server states on purpose; a second try gives the same answer. */
const FINAL_FAILURES = new Set([
  MISSING_AMOUNT_MESSAGE,
  "Kuitin kuukausi on suljettu.",
  "Kuitti on jo käsitelty.",
  "Kuittia ei löytynyt",
]);

export function retryableFailureIds(failed: ApprovalFailure[]): string[] {
  return failed.filter((item) => !FINAL_FAILURES.has(item.error)).map((item) => item.id);
}
