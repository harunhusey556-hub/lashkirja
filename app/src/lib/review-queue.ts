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

/**
 * The bulk-approve endpoint takes at most 200 ids per call (route.ts); a page
 * that grows its pending list or an import of many files must split.
 */
export const APPROVE_BATCH_LIMIT = 200;

export function chunkIds(ids: string[], size = APPROVE_BATCH_LIMIT): string[][] {
  const chunks: string[][] = [];
  for (let start = 0; start < ids.length; start += size) {
    chunks.push(ids.slice(start, start + size));
  }
  return chunks;
}

/**
 * The bulk-bar's approve label names the count it will act on, and says the
 * rest are left behind when the selection is not all ready ("Hyväksy valmiit").
 */
export function bulkApproveLabel(ready: number, notReady: number): string {
  return notReady === 0 ? `Hyväksy (${ready})` : `Hyväksy valmiit (${ready})`;
}

/**
 * The outcome of a bulk import+approve, exactly the two buckets the owner
 * asked for: what was approved and what still needs review ("Hyväksyttiin 187
 * kuittia · 13 vaatii tarkistusta").
 */
export function bulkImportSummary(approved: number, needsReview: number): string {
  const parts: string[] = [];
  if (approved > 0) {
    parts.push(approved === 1 ? "Hyväksyttiin 1 kuitti" : `Hyväksyttiin ${approved} kuittia`);
  }
  if (needsReview > 0) {
    parts.push(needsReview === 1 ? "1 vaatii tarkistusta" : `${needsReview} vaatii tarkistusta`);
  }
  return parts.length === 0 ? "Ei hyväksyttäviä kuitteja." : parts.join(" · ");
}

/** What the bulk import path reads off one ready upload (extracted fields only). */
export interface BulkImportReading {
  vendor?: string | null;
  date?: string | null;
  totalAmount?: number | null;
  category?: string | null;
  notes?: string | null;
  type?: string | null;
  reference?: string | null;
  invoiceNumber?: string | null;
  vatDetails?: { rate?: number; amount?: number }[] | null;
}

/**
 * The /api/receipts/save body for one ready upload: the AI reading, as the
 * form would submit it, so the bulk path writes exactly what the review
 * screen would. A missing amount stays null — the server refuses to approve
 * it later, which is what leaves it for review.
 */
export function bulkSavePayload(uploadId: string, reading: BulkImportReading) {
  return {
    uploadId,
    vendor: reading.vendor ?? null,
    date: reading.date ?? null,
    totalAmount: reading.totalAmount ?? null,
    category: reading.category ?? null,
    notes: reading.notes ?? null,
    type: reading.type === "tulo" ? "tulo" : "meno",
    reference: reading.reference ?? null,
    invoiceNumber: reading.invoiceNumber ?? null,
    vatDetails: (reading.vatDetails ?? [])
      .filter((line) => typeof line.rate === "number" && typeof line.amount === "number")
      .map((line) => ({ rate: line.rate as number, amount: line.amount as number })),
  };
}
