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

/** Suggested pairs of approved, unlinked receipts that are sure right now, re-scored. */
export async function listSureMatches(userId: string, db: Db = prisma): Promise<SurePair[]> {
  const rows = await db.transaction.findMany({
    where: {
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
}

export interface SureMatchBatch {
  /** Null when nothing was sure: there is nothing to undo. */
  batchId: string | null;
  linked: SurePair[];
}

/**
 * Links every sure pair in one database transaction: all of them or none. What
 * each pair looked like before is kept with the batch, so "Kumoa" can put the
 * suggestions (and a foreign receipt's amounts) back exactly.
 */
export async function linkSureMatches(userId: string, db: Prisma.TransactionClient | null = null): Promise<SureMatchBatch> {
  const run = async (client: Prisma.TransactionClient): Promise<SureMatchBatch> => {
    const pairs = await listSureMatches(userId, client);
    if (pairs.length === 0) return { batchId: null, linked: [] };
    const entries: BatchEntry[] = [];
    for (const pair of pairs) {
      const [row, receipt] = await Promise.all([
        client.transaction.findUniqueOrThrow({
          where: { id: pair.transactionId },
          select: { matchScore: true, matchReasons: true },
        }),
        client.receipt.findUniqueOrThrow({
          where: { id: pair.receiptId },
          select: { totalAmountCents: true, originalAmountCents: true, vatDetails: true },
        }),
      ]);
      entries.push({ ...pair, ...row, ...receipt });
      await confirmMatch(userId, pair.transactionId, pair.receiptId, true, client);
    }
    const event = await client.automationEvent.create({
      data: {
        userId,
        kind: SURE_MATCH_BATCH_KIND,
        resourceType: "batch",
        resourceId: pairs[0].transactionId,
        previousValue: JSON.stringify(entries),
        newValue: String(pairs.length),
        reason: "Kohdista varmat",
      },
      select: { id: true },
    });
    return { batchId: event.id, linked: pairs };
  };
  if (db) return run(db);
  return prisma.$transaction(run);
}

/**
 * "Kumoa" for one batch: every pair still linked as the batch left it goes back
 * to its suggestion. A pair the owner changed since is left alone. Repeating the
 * undo restores nothing more.
 */
export async function undoSureMatchBatch(userId: string, batchId: string): Promise<{ restored: number }> {
  return prisma.$transaction(async (db) => {
    const batch = await db.automationEvent.findFirst({
      where: { id: batchId, userId, kind: SURE_MATCH_BATCH_KIND },
      select: { id: true, previousValue: true },
    });
    if (!batch) throw new NotFoundError("Kohdistuserää ei löytynyt.");
    const undone = await db.automationEvent.findFirst({
      where: { userId, kind: SURE_MATCH_UNDO_KIND, resourceId: batch.id },
      select: { id: true },
    });
    if (undone) return { restored: 0 };

    const entries = JSON.parse(batch.previousValue ?? "[]") as BatchEntry[];
    let restored = 0;
    for (const entry of entries) {
      const row = await db.transaction.findFirst({
        where: { id: entry.transactionId, statement: { userId }, receiptId: entry.receiptId, matchStatus: "confirmed" },
        select: { id: true },
      });
      if (!row) continue;
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
      restored += 1;
    }
    await db.automationEvent.create({
      data: {
        userId,
        kind: SURE_MATCH_UNDO_KIND,
        resourceType: "batch",
        resourceId: batch.id,
        newValue: String(restored),
        reason: "Kumoa: Kohdista varmat",
      },
    });
    return { restored };
  });
}
