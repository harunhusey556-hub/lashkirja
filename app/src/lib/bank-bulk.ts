import { rowState, type FeedRow } from "@/lib/bank-feed";
import type { MatchCandidate } from "@/lib/statement-client";

/**
 * What the Pankki select mode can do with the rows that are ticked (W20).
 * Pure: it only sorts the selection into the request each action sends, so
 * the bar shows the true count of what an action will touch and a row an
 * action cannot take is left alone, never forced.
 */

export interface TxReceiptPair {
  transactionId: string;
  receiptId: string;
}

export interface MatchProposal {
  row: FeedRow;
  candidate: MatchCandidate["receipt"];
}

export interface BulkPlan {
  /** Rows with a suggested kuitti: `/api/matching/confirm-all` with exactly these pairs. */
  confirmPairs: TxReceiptPair[];
  /** Recognised sales waiting for "Hyväksy": `/api/receipts/batch-approve` (confirm-all skips drafts). */
  saleApprovals: Array<{ row: FeedRow; receiptId: string }>;
  /** Suggested rows and sales that can be turned down: `/api/matching/reject` per pair. */
  rejectable: Array<{ row: FeedRow; receiptId: string }>;
  /** Rows with no suggestion but a best candidate: the "Kohdista valitut" sheet. */
  proposals: MatchProposal[];
  /** Rows that can be marked "oma siirto": not yet documented, not a payment, not already a transfer. */
  transferable: FeedRow[];
}

/** The best-scoring candidate, never the first by accident of order. */
export function bestCandidate(row: Pick<FeedRow, "matchCandidates">): MatchCandidate | null {
  const candidates = row.matchCandidates ?? [];
  let best: MatchCandidate | null = null;
  for (const candidate of candidates) {
    if (!best || candidate.score > best.score) best = candidate;
  }
  return best;
}

export function planBulk(rows: readonly FeedRow[]): BulkPlan {
  const plan: BulkPlan = { confirmPairs: [], saleApprovals: [], rejectable: [], proposals: [], transferable: [] };
  const claimed = new Set<string>();
  for (const row of rows) {
    const state = rowState(row);
    if (state === "suggested" && row.suggestedReceiptId) {
      plan.confirmPairs.push({ transactionId: row.id, receiptId: row.suggestedReceiptId });
      plan.rejectable.push({ row, receiptId: row.suggestedReceiptId });
    } else if (state === "sale" && row.suggestedReceiptId) {
      plan.saleApprovals.push({ row, receiptId: row.suggestedReceiptId });
      plan.rejectable.push({ row, receiptId: row.suggestedReceiptId });
    } else if (state === "missing") {
      const best = bestCandidate(row);
      // One kuitti can document one row: the first selected row that proposes it keeps it.
      if (best && !claimed.has(best.receipt.id)) {
        claimed.add(best.receipt.id);
        plan.proposals.push({ row, candidate: best.receipt });
      }
    }
    if (state === "suggested" || state === "sale" || state === "missing" || state === "ignored") {
      plan.transferable.push(row);
    }
  }
  return plan;
}

/** "Hyväksy ehdotukset (3)". */
export function approveSuggestionsLabel(count: number): string {
  return `Hyväksy ehdotukset (${count})`;
}

export const bulkLabels = {
  reject: (count: number) => `Hylkää valitut (${count})`,
  match: (count: number) => `Kohdista valitut (${count})`,
  transfer: (count: number) => `Oma siirto (${count})`,
} as const;

function rows(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

/** The title of the confirmation sheet; it always names the count. */
export function bulkConfirmTitle(kind: "approve" | "reject" | "transfer" | "match", count: number): string {
  switch (kind) {
    case "approve":
      return `Hyväksytäänkö ${rows(count, "ehdotus", "ehdotusta")}?`;
    case "reject":
      return `Hylätäänkö ${rows(count, "ehdotus", "ehdotusta")}?`;
    case "match":
      return `Kohdistetaanko ${rows(count, "tapahtuma", "tapahtumaa")}?`;
    case "transfer":
      return `Merkitäänkö ${rows(count, "tapahtuma", "tapahtumaa")} omaksi siirroksi?`;
  }
}

export function bulkConfirmBody(kind: "approve" | "reject" | "transfer" | "match"): string {
  switch (kind) {
    case "approve":
      return "Ehdotetut kuitit kohdistetaan tapahtumiin ja myynnit kirjataan.";
    case "reject":
      return "Ehdotuksia ei näytetä näille tapahtumille uudelleen.";
    case "match":
      return "Jokainen tapahtuma saa listassa näkyvän kuitin.";
    case "transfer":
      return "Omia siirtoja ei lasketa tuloiksi tai menoiksi eivätkä ne tarvitse kuittia.";
  }
}

export const bulkConfirmLabel = {
  approve: "Hyväksy",
  reject: "Hylkää",
  transfer: "Merkitse",
  match: "Kohdista",
} as const;

/** One calm sentence for the toast after a bulk action. */
export function bulkOutcomeText(verb: string, done: number, failed: number): string {
  if (failed === 0) return `${verb} ${done}.`;
  if (done === 0) return `Mikään ei onnistunut (${failed} epäonnistui).`;
  return `${verb} ${done}, epäonnistui ${failed}.`;
}

/**
 * Runs `task` over `items` with at most `limit` in flight. Never rejects: the
 * result lists which items succeeded and which failed, in input order.
 */
export async function runLimited<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>
): Promise<{ done: T[]; failed: Array<{ item: T; error: unknown }> }> {
  const outcome: Array<{ item: T; error?: unknown; ok: boolean }> = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        await task(items[index]);
        outcome[index] = { item: items[index], ok: true };
      } catch (error: unknown) {
        outcome[index] = { item: items[index], ok: false, error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return {
    done: outcome.filter((entry) => entry.ok).map((entry) => entry.item),
    failed: outcome.filter((entry) => !entry.ok).map((entry) => ({ item: entry.item, error: entry.error })),
  };
}
