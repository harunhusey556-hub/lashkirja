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
import { AppError, ConflictError, NotFoundError } from "./api-errors";
import { IDEMPOTENCY_PROCESSING_MS, isUniqueConflict } from "./idempotency";
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

interface BatchEntry extends SurePair {
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
  /** Every pair the batch holds; a run that continued a batch also lists what the earlier run linked. */
  linked: SurePair[];
  /** The run stopped before the end (time ran out, or a chunk failed); what it linked stays linked and undoable. */
  partial?: true;
  /** Sure pairs the run did not reach; the next tap links them. */
  remaining?: number;
  /** A chunk failed and `error` is its code. A retry with the same Idempotency-Key continues the same batch. */
  failed?: true;
  error?: string;
}

/** Pairs per database transaction: a long backlog must not outrun one interactive transaction. */
export const SURE_MATCH_CHUNK = 50;
const CHUNK_TIMEOUT_MS = 15_000;
/** Wall clock of one run: the app's request gives up at 25 s, and its answer carries the batch to undo. */
export const SURE_RUN_BUDGET_MS = 20_000;
/** The longest a run can hold its owner's run marker: the budget plus the chunk it was in. */
export const SURE_RUN_MAX_MS = SURE_RUN_BUDGET_MS + CHUNK_TIMEOUT_MS;
/** IdempotencyRecord scope of the per-owner run marker: its unique (userId, scope, key) lets one run in at a time. */
export const SURE_RUN_LOCK_SCOPE = "matching.sure.running";
const SURE_RUN_LOCK_KEY = "run";

let runBudgetMs = SURE_RUN_BUDGET_MS;
let failChunkAt: number | null = null;

/** Test hook: the run's time budget (null = the real one). */
export function setSureRunBudgetForTests(ms: number | null): void {
  runBudgetMs = ms ?? SURE_RUN_BUDGET_MS;
}

/** Test hook: chunk `index` (0-based) of the next link or undo run throws. */
export function failSureMatchChunkForTests(index: number | null): void {
  failChunkAt = index;
}

function failChunkForTests(index: number): void {
  if (failChunkAt === null || failChunkAt !== index) return;
  failChunkAt = null;
  throw new Error("sure match chunk failed (test)");
}

function asPair(entry: BatchEntry): SurePair {
  const { transactionId, receiptId, vendor, amount, score, reasons } = entry;
  return { transactionId, receiptId, vendor, amount, score, reasons };
}

/**
 * Two runs of one owner would score the same backlog and split it between two
 * batches, each "Kumoa" covering only its part, so a second run is refused
 * while the first holds the marker. A crashed run leaves its marker behind;
 * one older than the stale window (longer than any run) is taken over.
 */
async function claimRunLock(userId: string): Promise<string> {
  await prisma.idempotencyRecord.deleteMany({
    where: {
      userId,
      scope: SURE_RUN_LOCK_SCOPE,
      key: SURE_RUN_LOCK_KEY,
      createdAt: { lt: new Date(Date.now() - IDEMPOTENCY_PROCESSING_MS) },
    },
  });
  try {
    const marker = await prisma.idempotencyRecord.create({
      data: { userId, scope: SURE_RUN_LOCK_SCOPE, key: SURE_RUN_LOCK_KEY, statusCode: 0, body: "" },
      select: { id: true },
    });
    return marker.id;
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;
    throw new ConflictError("Varmoja kohdistetaan jo. Odota hetki ja yritä uudelleen.", "SURE_MATCH_RUNNING");
  }
}

/**
 * The batch a run with the same key left unfinished (and nobody took back), or
 * a new empty one. Null when there is no such batch and nothing to link.
 */
async function openBatch(
  userId: string,
  runKey: string | null,
  hasCandidates: boolean
): Promise<{ id: string; entries: BatchEntry[]; created: boolean } | null> {
  const resourceId = runKey ? `key:${runKey}` : "run";
  if (runKey) {
    const earlier = await prisma.automationEvent.findFirst({
      where: { userId, kind: SURE_MATCH_BATCH_KIND, resourceId },
      select: { id: true, previousValue: true },
      orderBy: { createdAt: "desc" },
    });
    const undone =
      earlier &&
      (await prisma.automationEvent.findFirst({
        where: { userId, kind: SURE_MATCH_UNDO_KIND, resourceId: earlier.id },
        select: { id: true },
      }));
    if (earlier && !undone) {
      return { id: earlier.id, entries: JSON.parse(earlier.previousValue ?? "[]") as BatchEntry[], created: false };
    }
  }
  if (!hasCandidates) return null;
  const event = await prisma.automationEvent.create({
    data: {
      userId,
      kind: SURE_MATCH_BATCH_KIND,
      resourceType: "batch",
      resourceId,
      previousValue: "[]",
      newValue: "0",
      reason: "Kohdista varmat",
    },
    select: { id: true },
  });
  return { id: event.id, entries: [], created: true };
}

function errorCode(error: unknown): string {
  return error instanceof AppError ? error.code : "SURE_MATCH_CHUNK_FAILED";
}

/**
 * Links every sure pair, SURE_MATCH_CHUNK pairs per database transaction: each
 * chunk is all or nothing, and all chunks share one batch, so one "Kumoa" takes
 * back everything the run linked. What each pair looked like before is kept
 * with the batch, so "Kumoa" can put the suggestions (and a foreign receipt's
 * amounts) back exactly. Each chunk scores its pairs again, so a pair linked or
 * changed meanwhile (or by an interrupted earlier run) is not linked twice.
 *
 * The batch exists before the first chunk, so a run that stops early (its time
 * is up, or a chunk failed) still answers with it and what was linked can be
 * taken back. With `runKey` (the request's Idempotency-Key) a retry continues
 * the batch the same key left unfinished.
 */
export async function linkSureMatches(userId: string, options: { runKey?: string | null } = {}): Promise<SureMatchBatch> {
  const started = Date.now();
  const lock = await claimRunLock(userId);
  try {
    const runKey = options.runKey ?? null;
    const candidates = await listSureMatches(userId);
    const batch = await openBatch(userId, runKey, candidates.length > 0);
    if (!batch) return { batchId: null, linked: [] };
    let entries = batch.entries;
    let stopped: Pick<SureMatchBatch, "partial" | "remaining" | "failed" | "error"> = {};

    for (let start = 0, index = 0; start < candidates.length; start += SURE_MATCH_CHUNK, index += 1) {
      if (index > 0 && Date.now() - started >= runBudgetMs) {
        stopped = { partial: true, remaining: candidates.length - start };
        break;
      }
      const ids = candidates.slice(start, start + SURE_MATCH_CHUNK).map((pair) => pair.transactionId);
      try {
        entries = await prisma.$transaction(
          async (client) => {
            failChunkForTests(index);
            const pairs = await listSureMatches(userId, client, ids);
            if (pairs.length === 0) return entries;
            const added: BatchEntry[] = [];
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
              added.push({ ...pair, ...row, ...before, linkedAt: after.updatedAt.toISOString() });
            }
            const all = [...entries, ...added];
            await client.automationEvent.update({
              where: { id: batch.id },
              data: { previousValue: JSON.stringify(all), newValue: String(all.length) },
            });
            return all;
          },
          { timeout: CHUNK_TIMEOUT_MS }
        );
      } catch (error) {
        // Nothing linked yet: a plain error, as before chunking. Otherwise the
        // earlier chunks are committed, and the answer must carry their batch.
        if (entries.length === 0) {
          if (batch.created) await prisma.automationEvent.delete({ where: { id: batch.id } });
          throw error;
        }
        console.error(`Kohdista varmat stopped at chunk ${index} (user ${userId}, batch ${batch.id}, ${entries.length} linked)`, error);
        stopped = { partial: true, remaining: candidates.length - start, failed: true, error: errorCode(error) };
        break;
      }
    }

    if (entries.length === 0) {
      if (batch.created) await prisma.automationEvent.delete({ where: { id: batch.id } });
      return { batchId: null, linked: [] };
    }
    return { batchId: batch.id, linked: entries.map(asPair), ...stopped };
  } finally {
    await prisma.idempotencyRecord.deleteMany({ where: { id: lock } });
  }
}

export type SureUndoSkipReason = "edited" | "locked" | "changed";

export interface SureMatchUndo {
  /** How many pairs went back to their suggestion (`undone.length`). */
  restored: number;
  undone: Array<{ transactionId: string; receiptId: string }>;
  /** Left as they are: the link was changed, the receipt was edited after the batch, or its period is closed. */
  skipped: Array<{ transactionId: string; receiptId: string; reason: SureUndoSkipReason }>;
}

/** Thrown inside an undo chunk that another "Kumoa" of the same batch got to first: the chunk rolls back. */
class UndoOvertaken extends Error {}

/** Where a "Kumoa" got to: the marker's previousValue. Older markers hold only the skipped list, and those runs finished. */
interface UndoProgress {
  done: number;
  skipped: SureMatchUndo["skipped"];
}

function undoProgress(raw: string | null, total: number): UndoProgress {
  const parsed = JSON.parse(raw ?? "[]") as UndoProgress | SureMatchUndo["skipped"];
  return Array.isArray(parsed) ? { done: total, skipped: parsed } : parsed;
}

/**
 * "Kumoa" for one batch: every pair still linked as the batch left it goes back
 * to its suggestion. A pair the owner changed since (the link, or the receipt
 * edited after the batch) or one in a closed period is left alone and reported
 * as skipped.
 *
 * A long batch goes back SURE_MATCH_CHUNK pairs per transaction, like linking.
 * The undo marker (one per batch: its id is derived from the batch) records how
 * far the undo got, and each chunk moves it on only from where it read it, in
 * the same transaction as the pairs. So every pair is restored once: a second
 * "Kumoa" restores nothing more, and one after an undo that was cut off
 * continues where that one stopped. Each call answers what it restored itself.
 */
export async function undoSureMatchBatch(userId: string, batchId: string): Promise<SureMatchUndo> {
  const batch = await prisma.automationEvent.findFirst({
    where: { id: batchId, userId, kind: SURE_MATCH_BATCH_KIND },
    select: { id: true, previousValue: true, createdAt: true },
  });
  if (!batch) throw new NotFoundError("Kohdistuserää ei löytynyt.");
  const entries = JSON.parse(batch.previousValue ?? "[]") as BatchEntry[];
  const result: SureMatchUndo = { restored: 0, undone: [], skipped: [] };

  for (let index = 0; ; index += 1) {
    const step = await prisma.$transaction(
      async (db) => {
        failChunkForTests(index);
        let marker = await db.automationEvent.findFirst({
          where: { userId, kind: SURE_MATCH_UNDO_KIND, resourceId: batch.id },
          select: { id: true, previousValue: true, newValue: true },
        });
        if (!marker) {
          const progress: UndoProgress = { done: 0, skipped: [] };
          // The id is the batch's own: a second "Kumoa" at the same moment
          // cannot write a second marker, it fails on the key and finds this one.
          marker = await db.automationEvent.create({
            data: {
              id: `${batch.id}:undo`,
              userId,
              kind: SURE_MATCH_UNDO_KIND,
              resourceType: "batch",
              resourceId: batch.id,
              previousValue: JSON.stringify(progress),
              newValue: "0",
              reason: "Kumoa: Kohdista varmat",
            },
            select: { id: true, previousValue: true, newValue: true },
          });
        }
        const progress = undoProgress(marker.previousValue, entries.length);
        if (progress.done >= entries.length) return { finished: true, undone: [], skipped: [] };

        const lockedThrough = await getLockedThrough(userId, db);
        const undone: SureMatchUndo["undone"] = [];
        const skipped: SureMatchUndo["skipped"] = [];
        for (const entry of entries.slice(progress.done, progress.done + SURE_MATCH_CHUNK)) {
          const pair = { transactionId: entry.transactionId, receiptId: entry.receiptId };
          const row = await db.transaction.findFirst({
            where: { id: entry.transactionId, statement: { userId }, receiptId: entry.receiptId, matchStatus: "confirmed" },
            select: { id: true, date: true, receipt: { select: { date: true, updatedAt: true } } },
          });
          if (!row?.receipt) {
            skipped.push({ ...pair, reason: "changed" });
            continue;
          }
          const linkedAt = entry.linkedAt ? new Date(entry.linkedAt) : batch.createdAt;
          if (row.receipt.updatedAt.getTime() > linkedAt.getTime()) {
            skipped.push({ ...pair, reason: "edited" });
            continue;
          }
          // Same boundary as unlinking by hand: a closed month's books stay as filed.
          if (isDateLocked(lockedThrough, row.receipt.date) || isDateLocked(lockedThrough, row.date)) {
            skipped.push({ ...pair, reason: "locked" });
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
          undone.push(pair);
        }
        const next: UndoProgress = {
          done: Math.min(entries.length, progress.done + SURE_MATCH_CHUNK),
          skipped: [...progress.skipped, ...skipped],
        };
        // Moved on only from where this chunk read it: a "Kumoa" that got here
        // first leaves count 0, and this chunk's writes roll back with the throw.
        const moved = await db.automationEvent.updateMany({
          where: { id: marker.id, previousValue: marker.previousValue },
          data: {
            previousValue: JSON.stringify(next),
            newValue: String(Number(marker.newValue ?? "0") + undone.length),
          },
        });
        if (moved.count === 0) throw new UndoOvertaken();
        return { finished: next.done >= entries.length, undone, skipped };
      },
      { timeout: CHUNK_TIMEOUT_MS }
    ).catch((error: unknown) => {
      // Another "Kumoa" of this batch is restoring the same pairs: it answers for them.
      if (error instanceof UndoOvertaken || isUniqueConflict(error)) return null;
      throw error;
    });
    if (!step) break;
    result.undone.push(...step.undone);
    result.skipped.push(...step.skipped);
    if (step.finished) break;
  }
  result.restored = result.undone.length;
  return result;
}
