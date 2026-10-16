/**
 * "Kohdista varmat (N)" in Kuitit → Ei kohdistettu (owner 2026-10-15): one tap
 * links every receipt whose suggested bank row is a sure pair, and one "Kumoa"
 * takes the whole batch back.
 *
 * Sure is not a new score. It is the gate's own `certain` (the viite and the
 * exact amount agree) or the rule a matching run already posts by itself
 * (shouldAutoConfirm). The stored suggestion only says which pair to look at:
 * the pair is scored again here, so a list painted earlier cannot link a pair
 * the gate no longer stands behind.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "./db";
import { NotFoundError } from "./api-errors";
import { centsToEuros } from "./money";
import { confirmMatch, scorePair, shouldAutoConfirm } from "./matching";
import { getLockedThrough, isDateLocked } from "./period-lock";

/** AutomationEvent kind of one "Kohdista varmat" batch; previousValue keeps what undo restores. */
export const SURE_MATCH_BATCH_KIND = "sure_match_batch";
/** AutomationEvent kind written when a batch was taken back, so a second "Kumoa" writes nothing. */
export const SURE_MATCH_UNDO_KIND = "sure_match_undo";

type Db = Prisma.TransactionClient | typeof prisma;

export interface SurePair {
  transactionId: string;
  receiptId: string;
  vendor: string | null;
  /** The receipt's euro amount. */
  amount: number | null;
  score: number;
  /** Finnish reasons for "Miksi". */
  reasons: string[];
}

/** The gate's certain pair, or one a matching run would post by itself. `competing` comes from the stored run. */
export function isSureMatch(fresh: { score: number; reasons: string[]; certain: boolean }, competing: boolean): boolean {
  if (fresh.certain) return true;
  return shouldAutoConfirm(fresh.score, competing ? [...fresh.reasons, "competing"] : fresh.reasons);
}

function storedCodes(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    // Unreadable stored reasons only lose the rival marker; the fresh score still decides.
    return [];
  }
}

/** Suggested pairs of approved, unlinked receipts that are sure right now, re-scored; optionally only these bank rows. */
export async function listSureMatches(
  userId: string,
  db: Db = prisma,
  onlyTransactionIds: string[] | null = null
): Promise<SurePair[]> {
  const rows = await db.transaction.findMany({
    where: {
      ...(onlyTransactionIds ? { id: { in: onlyTransactionIds } } : {}),
      statement: { userId },
      matchStatus: "suggested",
      receiptId: null,
      suggestedReceipt: {
        userId,
        reviewStatus: "approved",
        linkedTransaction: null,
        // An income draft is approved one by one with "Hyväksy" (same rule as confirm-all).
        source: { not: "auto_income" },
      },
    },
    select: {
      id: true,
      date: true,
      counterparty: true,
      amountCents: true,
      reference: true,
      message: true,
      type: true,
      matchReasons: true,
      suggestedReceipt: {
        select: {
          id: true,
          vendor: true,
          date: true,
          totalAmountCents: true,
          type: true,
          reference: true,
          invoiceNumber: true,
        },
      },
    },
    orderBy: { date: "asc" },
  });

  const sure: SurePair[] = [];
  for (const row of rows) {
    const receipt = row.suggestedReceipt;
    if (!receipt) continue;
    const fresh = scorePair(
      { ...row, amount: centsToEuros(row.amountCents) },
      { ...receipt, totalAmount: receipt.totalAmountCents == null ? null : centsToEuros(receipt.totalAmountCents) }
    );
    if (!fresh || !fresh.eligible) continue;
    if (!isSureMatch(fresh, storedCodes(row.matchReasons).includes("competing"))) continue;
    sure.push({
      transactionId: row.id,
      receiptId: receipt.id,
      vendor: receipt.vendor,
      amount: receipt.totalAmountCents == null ? null : centsToEuros(receipt.totalAmountCents),
      score: fresh.score,
      reasons: fresh.explanation,
    });
  }
  return sure;
}

interface BatchEntry {
  transactionId: string;
  receiptId: string;
  matchScore: number | null;
  matchReasons: string | null;
  totalAmountCents: number | null;
  originalAmountCents: number | null;
  vatDetails: string | null;
  /** The receipt's updatedAt right after the batch linked it; a later one is the owner's edit. Absent in older batches. */
  linkedAt?: string;
}

export interface SureMatchBatch {
  /** Null when nothing was sure: there is nothing to undo. */
  batchId: string | null;
  linked: SurePair[];
}

/** Pairs per database transaction: a long backlog must not outrun one interactive transaction. */
export const SURE_MATCH_CHUNK = 50;
const CHUNK_TIMEOUT_MS = 30_000;

/**
 * Links every sure pair, SURE_MATCH_CHUNK pairs per database transaction: each
 * chunk is all or nothing, and all chunks share one batch, so one "Kumoa" takes
 * back everything the run linked. What each pair looked like before is kept
 * with the batch, so "Kumoa" can put the suggestions (and a foreign receipt's
 * amounts) back exactly. Each chunk scores its pairs again, so a pair linked or
 * changed meanwhile (or by an interrupted earlier run) is not linked twice.
 */
export async function linkSureMatches(userId: string): Promise<SureMatchBatch> {
  const candidates = await listSureMatches(userId);
  let batchId: string | null = null;
  const linked: SurePair[] = [];
  for (let start = 0; start < candidates.length; start += SURE_MATCH_CHUNK) {
    const ids = candidates.slice(start, start + SURE_MATCH_CHUNK).map((pair) => pair.transactionId);
    const chunk: { batchId: string | null; pairs: SurePair[] } = await prisma.$transaction(
      async (client) => {
        const pairs = await listSureMatches(userId, client, ids);
        if (pairs.length === 0) return { batchId, pairs };
        const entries: BatchEntry[] = [];
        for (const pair of pairs) {
          const [row, before] = await Promise.all([
            client.transaction.findUniqueOrThrow({
              where: { id: pair.transactionId },
              select: { matchScore: true, matchReasons: true },
            }),
            client.receipt.findUniqueOrThrow({
              where: { id: pair.receiptId },
              select: { totalAmountCents: true, originalAmountCents: true, vatDetails: true },
            }),
          ]);
          await confirmMatch(userId, pair.transactionId, pair.receiptId, true, client);
          const after = await client.receipt.findUniqueOrThrow({
            where: { id: pair.receiptId },
            select: { updatedAt: true },
          });
          entries.push({ ...pair, ...row, ...before, linkedAt: after.updatedAt.toISOString() });
        }
        if (!batchId) {
          const event = await client.automationEvent.create({
            data: {
              userId,
              kind: SURE_MATCH_BATCH_KIND,
              resourceType: "batch",
              resourceId: pairs[0].transactionId,
              previousValue: JSON.stringify(entries),
              newValue: String(entries.length),
              reason: "Kohdista varmat",
            },
            select: { id: true },
          });
          return { batchId: event.id, pairs };
        }
        const batch = await client.automationEvent.findUniqueOrThrow({
          where: { id: batchId },
          select: { previousValue: true },
        });
        const all = [...(JSON.parse(batch.previousValue ?? "[]") as BatchEntry[]), ...entries];
        await client.automationEvent.update({
          where: { id: batchId },
          data: { previousValue: JSON.stringify(all), newValue: String(all.length) },
        });
        return { batchId, pairs };
      },
      { timeout: CHUNK_TIMEOUT_MS }
    );
    batchId = chunk.batchId;
    linked.push(...chunk.pairs);
  }
  return { batchId, linked };
}

export type SureUndoSkipReason = "edited" | "locked" | "changed";

export interface SureMatchUndo {
  /** How many pairs went back to their suggestion (`undone.length`). */
  restored: number;
  undone: Array<{ transactionId: string; receiptId: string }>;
  /** Left as they are: the link was changed, the receipt was edited after the batch, or its period is closed. */
  skipped: Array<{ transactionId: string; receiptId: string; reason: SureUndoSkipReason }>;
}

/**
 * "Kumoa" for one batch: every pair still linked as the batch left it goes back
 * to its suggestion. A pair the owner changed since (the link, or the receipt
 * edited after the batch) or one in a closed period is left alone and reported
 * as skipped. The undo marker is checked and written in the same transaction,
 * so a second "Kumoa" restores nothing more.
 */
export async function undoSureMatchBatch(userId: string, batchId: string): Promise<SureMatchUndo> {
  return prisma.$transaction(
    async (db) => {
      const batch = await db.automationEvent.findFirst({
        where: { id: batchId, userId, kind: SURE_MATCH_BATCH_KIND },
        select: { id: true, previousValue: true, createdAt: true },
      });
      if (!batch) throw new NotFoundError("Kohdistuserää ei löytynyt.");
      const result: SureMatchUndo = { restored: 0, undone: [], skipped: [] };
      const marker = await db.automationEvent.findFirst({
        where: { userId, kind: SURE_MATCH_UNDO_KIND, resourceId: batch.id },
        select: { id: true },
      });
      if (marker) return result;
      // The marker is written before any pair is touched: in SQLite that write
      // takes the database lock, so a second "Kumoa" at the same moment waits
      // for this one to commit and then finds the marker.
      const undoEvent = await db.automationEvent.create({
        data: {
          userId,
          kind: SURE_MATCH_UNDO_KIND,
          resourceType: "batch",
          resourceId: batch.id,
          newValue: "0",
          reason: "Kumoa: Kohdista varmat",
        },
        select: { id: true },
      });
      const lockedThrough = await getLockedThrough(userId, db);

      const entries = JSON.parse(batch.previousValue ?? "[]") as BatchEntry[];
      for (const entry of entries) {
        const pair = { transactionId: entry.transactionId, receiptId: entry.receiptId };
        const row = await db.transaction.findFirst({
          where: { id: entry.transactionId, statement: { userId }, receiptId: entry.receiptId, matchStatus: "confirmed" },
          select: { id: true, date: true, receipt: { select: { date: true, updatedAt: true } } },
        });
        if (!row?.receipt) {
          result.skipped.push({ ...pair, reason: "changed" });
          continue;
        }
        const linkedAt = entry.linkedAt ? new Date(entry.linkedAt) : batch.createdAt;
        if (row.receipt.updatedAt.getTime() > linkedAt.getTime()) {
          result.skipped.push({ ...pair, reason: "edited" });
          continue;
        }
        // Same boundary as unlinking by hand: a closed month's books stay as filed.
        if (isDateLocked(lockedThrough, row.receipt.date) || isDateLocked(lockedThrough, row.date)) {
          result.skipped.push({ ...pair, reason: "locked" });
          continue;
        }
        await db.transaction.update({
          where: { id: row.id },
          data: {
            receiptId: null,
            matchStatus: "suggested",
            suggestedReceiptId: entry.receiptId,
            matchScore: entry.matchScore,
            matchReasons: entry.matchReasons,
          },
        });
        await db.receipt.update({
          where: { id: entry.receiptId },
          data: {
            totalAmountCents: entry.totalAmountCents,
            originalAmountCents: entry.originalAmountCents,
            vatDetails: entry.vatDetails,
          },
        });
        result.undone.push(pair);
      }
      result.restored = result.undone.length;
      await db.automationEvent.update({
        where: { id: undoEvent.id },
        data: { newValue: String(result.restored), previousValue: JSON.stringify(result.skipped) },
      });
      return result;
    },
    { timeout: CHUNK_TIMEOUT_MS }
  );
}
