/**
 * Auto-accept after upload (wave 2, owner problem C): "when I add 100 receipts
 * they should be accepted into Kuitit by themselves; I will look at the ones
 * that are not". One rule, used by the upload queue (to decide which path a
 * finished file takes) and by POST /api/receipts/save (which decides for real,
 * on the row it is creating, inside the same transaction).
 *
 * A reading is accepted only when nothing about it needs a human: vendor, a
 * positive euro amount and a date are present, the reading was confident, it
 * is a receipt or a bill (not a flyer), and it is not a likely duplicate.
 * Everything else is saved as pending and lands in the review queue.
 *
 * Pure: no Prisma, no fetch, so the client bundle can import it.
 */
import { serverApprovalBlock } from "./receipt-approval";
import { LOW_CONFIDENCE } from "./receipt-confidence";

/**
 * A per-user setting is not needed yet: the owner asked for this as the
 * default, and anything the rule refuses still lands in the review queue.
 */
export const AUTO_ACCEPT_COMPLETE_RECEIPTS = true;

/** How many saves the upload queue keeps on the wire at once. */
export const AUTO_SAVE_CONCURRENCY = 4;

export interface AutoAcceptInput {
  vendor?: string | null;
  /** ISO date string (client reading) or a Date (stored row). */
  date?: string | Date | null;
  totalAmountCents?: number | null;
  /** Euros, as the client reading carries it. Either amount field may be given. */
  totalAmount?: number | null;
  /** Overall recognition score, 0..1. */
  confidence?: number | null;
  fieldConfidence?: { vendor?: number | null; date?: number | null; totalAmount?: number | null } | null;
  /** extractionSource / Receipt.source: "manual" means nothing could be read. */
  source?: string | null;
  unreadable?: boolean;
  documentType?: string | null;
  /** The save route found (or the client acknowledged) the same vendor, date and sum. */
  duplicate?: boolean;
}

export type AutoAcceptBlock =
  | "unreadable"
  | "amount"
  | "vendor"
  | "date"
  | "not_a_receipt"
  | "low_confidence"
  | "duplicate";

function amountCents(input: AutoAcceptInput): number | null {
  if (input.totalAmountCents != null) return input.totalAmountCents;
  if (input.totalAmount != null) return Math.round(input.totalAmount * 100);
  return null;
}

function confident(score: number | null | undefined): boolean {
  return score != null && Number.isFinite(score) && score >= LOW_CONFIDENCE;
}

/** Why this reading must wait for the owner; null = accept it automatically. */
export function autoAcceptBlock(input: AutoAcceptInput): AutoAcceptBlock | null {
  if (input.unreadable || input.source === "manual") return "unreadable";
  // The same gate the manual approve path uses (review/route.ts), plus: a zero
  // or negative "receipt" is a misread or a credit, never something to book blind.
  const cents = amountCents(input);
  if (serverApprovalBlock({ totalAmountCents: cents }) || cents == null || cents <= 0) return "amount";
  if (!input.vendor || !input.vendor.trim()) return "vendor";
  const hasDate = input.date instanceof Date ? !Number.isNaN(input.date.getTime()) : Boolean(input.date);
  if (!hasDate) return "date";
  if (input.documentType === "marketing" || input.documentType === "other") return "not_a_receipt";
  if (!confident(input.confidence)) return "low_confidence";
  const fields = input.fieldConfidence;
  if (fields) {
    for (const score of [fields.vendor, fields.date, fields.totalAmount]) {
      if (score != null && Number.isFinite(score) && score < LOW_CONFIDENCE) return "low_confidence";
    }
  }
  if (input.duplicate) return "duplicate";
  return null;
}

export function canAutoAccept(input: AutoAcceptInput): boolean {
  return AUTO_ACCEPT_COMPLETE_RECEIPTS && autoAcceptBlock(input) === null;
}

/**
 * Which way a finished upload goes: saved by the queue (in a pick of several
 * files every reading is saved - complete ones approved, the rest pending - and
 * a single file only when complete), or opened in the form as before.
 */
export function takesAutoSavePath(input: {
  enabled: boolean;
  several: boolean;
  reading: AutoAcceptInput;
}): boolean {
  if (!input.enabled) return false;
  return input.several || canAutoAccept(input.reading);
}

export interface UploadOutcomeCounts {
  approved: number;
  pending: number;
  failed: number;
  /** Still being read on the server; not saved yet. */
  background: number;
}

export function uploadOutcomeCounts(
  rows: Array<{ status: string; outcome?: "approved" | "pending" }>
): UploadOutcomeCounts {
  const counts: UploadOutcomeCounts = { approved: 0, pending: 0, failed: 0, background: 0 };
  for (const row of rows) {
    if (row.status === "saved" && row.outcome === "approved") counts.approved += 1;
    else if (row.status === "saved") counts.pending += 1;
    else if (row.status === "failed") counts.failed += 1;
    else if (row.status === "background") counts.background += 1;
  }
  return counts;
}

/** "Hyväksyttiin automaattisesti 87 · 11 odottaa tarkistusta · 2 epäonnistui" */
export function autoAcceptSummary(counts: UploadOutcomeCounts): string {
  const parts: string[] = [];
  if (counts.approved > 0) parts.push(`Hyväksyttiin automaattisesti ${counts.approved}`);
  if (counts.pending > 0) parts.push(`${counts.pending} odottaa tarkistusta`);
  if (counts.failed > 0) parts.push(`${counts.failed} epäonnistui`);
  if (counts.background > 0) parts.push(`${counts.background} käsitellään taustalla`);
  return parts.length === 0 ? "Yhtään kuittia ei tallennettu." : parts.join(" · ");
}

/**
 * Runs at most `limit` tasks at a time, in call order. A rejected task frees
 * its slot like a finished one, so one failure never stalls the rest.
 */
export function createLimiter(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  // A freed slot is handed straight to the next waiter (active stays the same),
  // so a caller arriving in between can never squeeze past the limit.
  const release = () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };
  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= Math.max(1, limit)) {
      await new Promise<void>((resolve) => waiting.push(resolve));
    } else {
      active += 1;
    }
    try {
      return await task();
    } finally {
      release();
    }
  };
}
