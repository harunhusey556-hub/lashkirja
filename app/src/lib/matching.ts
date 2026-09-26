// Relative import so standalone scripts (tsx) can load this module too
import { prisma } from "./db";
import { centsToEuros } from "./money";

/**
 * Deterministic bank-transaction ↔ receipt matcher.
 *
 * Scoring is transparent and auditable: each signal contributes a fixed
 * weight, thresholds decide suggested vs candidate vs unmatched. AI is never
 * asked to pick a match — it only extracts fields upstream.
 */

export interface MatchTx {
  id: string;
  date: Date | null;
  counterparty: string | null;
  amount: number;
  reference: string | null;
  message: string | null;
  type: string;
}

export interface MatchReceipt {
  id: string;
  vendor: string | null;
  date: Date | null;
  totalAmount: number | null;
  type: string;
  reference: string | null;
  invoiceNumber: string | null;
  /** Only "approved" documents may post automatically. Pending ones can still
   *  be scored and suggested, they just never auto-confirm. */
  reviewStatus?: string;
}

export interface ScoredPair {
  transactionId: string;
  receiptId: string;
  score: number;
  reasons: string[];
}

export const SUGGEST_THRESHOLD = 0.85;
export const CANDIDATE_THRESHOLD = 0.55;
/** Strong matches link immediately without manual approval. */
export const AUTO_CONFIRM_THRESHOLD = 0.85;

/**
 * Evidence-based, not score-based. Posting to the books without a human needs
 * proof the pair belongs together, and only two signals are proof:
 *
 *   viite  — the bank reference equals the receipt reference or invoice number
 *   amount — the amounts agree to the cent
 *
 * vendor and date are weak. `date` is pushed for *any* proximity inside a
 * 35-day window, so the old `amount + date` rule auto-posted on little more
 * than "same amount, same month" — two identical MobilePay payments would link
 * to whichever receipt sorted first. `competing` marks a pair that had a
 * plausible rival, which means the evidence is not decisive.
 */
export function shouldAutoConfirm(score: number, reasons: string[]): boolean {
  if (score < AUTO_CONFIRM_THRESHOLD) return false;
  if (reasons.includes("competing")) return false;
  return reasons.includes("viite") && reasons.includes("amount");
}

const WEIGHT_VIITE = 0.45;
const WEIGHT_AMOUNT = 0.45;
const WEIGHT_VENDOR = 0.3;
const WEIGHT_DATE = 0.2;

// Invoice date vs payment date: Finnish laskut are paid on 14-30 day terms,
// card kuitit hit the bank within days.
const DATE_WINDOW_LASKU_DAYS = 35;
const DATE_WINDOW_KUITTI_DAYS = 5;

/** Normalize a Finnish viite / invoice number for comparison.
 *  RF-references ("RF18 1009") reduce to the underlying viite. */
export function normalizeRef(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (/^RF\d{2}/.test(s)) s = s.slice(4);
  s = s.replace(/^0+/, "");
  return s.length >= 2 ? s : null;
}

const LEGAL_SUFFIXES =
  /\b(OY|OYJ|AB|KY|TMI|T:MI|LTD|OSK|RY|GMBH|INC|AS)\b/g;

function normalizeName(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .toUpperCase()
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/[^A-ZÄÖÅ0-9]+/g, " ")
    .split(" ")
    .filter((t) => t.length >= 2);
}

function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const matrix = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }
  return matrix[a.length][b.length];
}

function fuzzyTokenMatch(t1: string, t2: string): boolean {
  if (t1 === t2) return true;
  if (t1.length >= 4 && t2.length >= 4) {
    // Allow small typos (dist <= 2 for longer words, 1 for shorter ones)
    const threshold = Math.max(1, Math.floor(Math.min(t1.length, t2.length) / 3));
    return levenshteinDistance(t1, t2) <= threshold;
  }
  return false;
}

/** 0..1 similarity between receipt vendor and a bank-row name/message using fuzzy matching. */
export function nameSimilarity(
  vendor: string | null | undefined,
  bankText: string | null | undefined
): number {
  const a = normalizeName(vendor);
  const b = normalizeName(bankText);
  if (a.length === 0 || b.length === 0) return 0;
  let matches = 0;
  for (const tA of a) {
    if (b.some(tB => fuzzyTokenMatch(tA, tB))) matches++;
  }
  return matches / Math.min(a.length, b.length);
}

function dayDiff(a: Date, b: Date): number {
  return Math.abs(a.getTime() - b.getTime()) / 86_400_000;
}

/** Score one tx↔receipt pair. Returns null when the pair is gated out. */
export function scorePair(
  tx: MatchTx,
  receipt: MatchReceipt
): { score: number; reasons: string[] } | null {
  // Sign/type gate: money direction must agree; oma_siirto never matches.
  if (tx.type !== "tulo" && tx.type !== "meno") return null;
  if (receipt.type !== tx.type) return null;

  let score = 0;
  const reasons: string[] = [];

  const txRef = normalizeRef(tx.reference);
  const rRef = normalizeRef(receipt.reference);
  const rInv = normalizeRef(receipt.invoiceNumber);
  const viiteHit =
    txRef !== null && (txRef === rRef || txRef === rInv);
  if (viiteHit) {
    score += WEIGHT_VIITE;
    reasons.push("viite");
  }

  if (
    receipt.totalAmount !== null &&
    receipt.totalAmount > 0 &&
    Math.abs(Math.abs(tx.amount) - receipt.totalAmount) <= 0.011
  ) {
    score += WEIGHT_AMOUNT;
    reasons.push("amount");
  }

  const vendorSim = Math.max(
    nameSimilarity(receipt.vendor, tx.counterparty),
    nameSimilarity(receipt.vendor, tx.message)
  );
  if (vendorSim >= 0.5) {
    score += WEIGHT_VENDOR * vendorSim;
    reasons.push("vendor");
  }

  if (tx.date && receipt.date) {
    const isLasku = rRef !== null || rInv !== null;
    const window = isLasku ? DATE_WINDOW_LASKU_DAYS : DATE_WINDOW_KUITTI_DAYS;
    const proximity = Math.max(0, 1 - dayDiff(tx.date, receipt.date) / window);
    if (proximity > 0) {
      score += WEIGHT_DATE * proximity;
      reasons.push("date");
    }
  }

  return { score: Math.round(score * 1000) / 1000, reasons };
}

function pairKey(transactionId: string, receiptId: string): string {
  return `${transactionId}:${receiptId}`;
}

/**
 * Score every allowed pair and assign greedily (highest score first) so one
 * receipt is suggested to at most one transaction. Only pairs at or above
 * SUGGEST_THRESHOLD become suggestions.
 */
export function computeSuggestions(
  txs: MatchTx[],
  receipts: MatchReceipt[],
  rejectedPairs: Set<string>
): ScoredPair[] {
  // Kept down to CANDIDATE_THRESHOLD rather than SUGGEST_THRESHOLD: a rival
  // scoring 0.6 is still a reason not to post automatically, and filtering at
  // 0.85 here would hide exactly the ambiguity the competing check looks for.
  const plausible: ScoredPair[] = [];
  for (const tx of txs) {
    for (const receipt of receipts) {
      if (rejectedPairs.has(pairKey(tx.id, receipt.id))) continue;
      const result = scorePair(tx, receipt);
      if (result && result.score >= CANDIDATE_THRESHOLD) {
        plausible.push({
          transactionId: tx.id,
          receiptId: receipt.id,
          score: result.score,
          reasons: result.reasons,
        });
      }
    }
  }

  const scored = plausible.filter((p) => p.score >= SUGGEST_THRESHOLD);
  scored.sort((a, b) => b.score - a.score);
  const usedTx = new Set<string>();
  const usedReceipt = new Set<string>();
  const assignments: ScoredPair[] = [];
  for (const pair of scored) {
    if (usedTx.has(pair.transactionId) || usedReceipt.has(pair.receiptId)) {
      continue;
    }
    usedTx.add(pair.transactionId);
    usedReceipt.add(pair.receiptId);
    assignments.push(pair);
  }

  // Greedy assignment always produces a single winner, which hides ambiguity:
  // with two plausible receipts the highest score wins silently. Flag any
  // winner that had a real rival on either side so it cannot auto-post.
  // The pair stays a suggestion for the user to resolve.
  for (const pair of assignments) {
    const hasRival = plausible.some(
      (other) =>
        other !== pair &&
        (other.transactionId === pair.transactionId ||
          other.receiptId === pair.receiptId)
    );
    if (hasRival && !pair.reasons.includes("competing")) {
      pair.reasons = [...pair.reasons, "competing"];
    }
  }

  return assignments;
}

/** Scored shortlist for one transaction ("Valitse kuitti" UI). */
export function candidatesFor(
  tx: MatchTx,
  receipts: MatchReceipt[],
  rejectedPairs: Set<string>,
  limit = 5
): ScoredPair[] {
  const scored: ScoredPair[] = [];
  for (const receipt of receipts) {
    if (rejectedPairs.has(pairKey(tx.id, receipt.id))) continue;
    const result = scorePair(tx, receipt);
    if (result && result.score >= 0.15) {
      scored.push({
        transactionId: tx.id,
        receiptId: receipt.id,
        score: result.score,
        reasons: result.reasons,
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/** Scored shortlist for one receipt ("which bank row fits this kuitti?"). */
export function candidatesForReceipt(
  receipt: MatchReceipt,
  txs: MatchTx[],
  rejectedPairs: Set<string>,
  limit = 3
): ScoredPair[] {
  const scored: ScoredPair[] = [];
  for (const tx of txs) {
    if (rejectedPairs.has(pairKey(tx.id, receipt.id))) continue;
    const result = scorePair(tx, receipt);
    if (result && result.score >= 0.15) {
      scored.push({
        transactionId: tx.id,
        receiptId: receipt.id,
        score: result.score,
        reasons: result.reasons,
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export interface BankTxMatchSummary {
  id: string;
  date: Date | null;
  counterparty: string | null;
  amount: number;
  matchStatus: string;
  matchScore: number | null;
  matchReasons: string[] | null;
  statement: { periodMonth: string | null; fileName: string } | null;
}

export interface ReceiptMatchView {
  status: "linked" | "suggested" | "unlinked";
  linkedTransaction: BankTxMatchSummary | null;
  suggestedTransaction:
    | (BankTxMatchSummary & { score: number; reasons: string[] })
    | null;
  matchCandidates: Array<BankTxMatchSummary & { score: number; reasons: string[] }>;
}

function parseMatchReasons(raw: string | null | undefined): string[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v) => typeof v === "string") : null;
  } catch {
    return null;
  }
}

function toBankTxSummary(tx: {
  id: string;
  date: Date | null;
  counterparty: string | null;
  amountCents: number;
  matchStatus: string;
  matchScore: number | null;
  matchReasons: string | null;
  statement: { periodMonth: string | null; fileName: string } | null;
}): BankTxMatchSummary {
  return {
    id: tx.id,
    date: tx.date,
    counterparty: tx.counterparty,
    amount: centsToEuros(tx.amountCents),
    matchStatus: tx.matchStatus,
    matchScore: tx.matchScore,
    matchReasons: parseMatchReasons(tx.matchReasons),
    statement: tx.statement,
  };
}

/** Match state per receipt for list/detail UI (linked, suggested, or top picks). */
export async function buildReceiptMatchViews(
  userId: string,
  receipts: Array<{
    id: string;
    vendor: string | null;
    date: Date | null;
    totalAmount: number | null;
    type: string;
    reference: string | null;
    invoiceNumber: string | null;
    linkedTransaction?: {
      id: string;
      date: Date | null;
      counterparty: string | null;
      amountCents: number;
      matchStatus: string;
      matchScore: number | null;
      matchReasons: string | null;
      statement: { periodMonth: string | null; fileName: string } | null;
    } | null;
  }>
): Promise<Map<string, ReceiptMatchView>> {
  const result = new Map<string, ReceiptMatchView>();
  if (receipts.length === 0) return result;

  const receiptIds = receipts.map((r) => r.id);
  const needsCandidates = receipts.filter((r) => !r.linkedTransaction);

  const [suggestedTxs, openTxs, rejections] = await Promise.all([
    prisma.transaction.findMany({
      where: {
        suggestedReceiptId: { in: receiptIds },
        matchStatus: "suggested",
        statement: { userId },
      },
      select: {
        id: true,
        date: true,
        counterparty: true,
        amountCents: true,
        matchStatus: true,
        matchScore: true,
        matchReasons: true,
        suggestedReceiptId: true,
        statement: { select: { periodMonth: true, fileName: true } },
      },
    }),
    needsCandidates.length > 0
      ? prisma.transaction.findMany({
          where: {
            statement: { userId },
            matchStatus: { in: ["unmatched", "suggested"] },
            type: { in: ["tulo", "meno"] },
            receiptId: null,
          },
          select: {
            id: true,
            date: true,
            counterparty: true,
            amountCents: true,
            reference: true,
            message: true,
            type: true,
            matchStatus: true,
            matchScore: true,
            matchReasons: true,
            statement: { select: { periodMonth: true, fileName: true } },
          },
        })
      : Promise.resolve([]),
    prisma.matchRejection.findMany({
      where: { receiptId: { in: receiptIds } },
      select: { transactionId: true, receiptId: true },
    }),
  ]);

  const suggestedByReceipt = new Map(
    suggestedTxs
      .filter((tx) => tx.suggestedReceiptId)
      .map((tx) => [tx.suggestedReceiptId!, tx])
  );
  const rejectedPairs = new Set(
    rejections.map((r) => pairKey(r.transactionId, r.receiptId))
  );
  const openTxModels = openTxs.map(({ amountCents, ...tx }) => ({
    ...tx,
    amount: centsToEuros(amountCents),
  }));

  for (const receipt of receipts) {
    if (receipt.linkedTransaction) {
      result.set(receipt.id, {
        status: "linked",
        linkedTransaction: toBankTxSummary(receipt.linkedTransaction),
        suggestedTransaction: null,
        matchCandidates: [],
      });
      continue;
    }

    const suggested = suggestedByReceipt.get(receipt.id);
    if (suggested) {
      result.set(receipt.id, {
        status: "suggested",
        linkedTransaction: null,
        suggestedTransaction: {
          ...toBankTxSummary(suggested),
          score: suggested.matchScore ?? SUGGEST_THRESHOLD,
          reasons: parseMatchReasons(suggested.matchReasons) ?? [],
        },
        matchCandidates: [],
      });
      continue;
    }

    const receiptModel: MatchReceipt = {
      id: receipt.id,
      vendor: receipt.vendor,
      date: receipt.date,
      totalAmount: receipt.totalAmount,
      type: receipt.type,
      reference: receipt.reference,
      invoiceNumber: receipt.invoiceNumber,
    };
    const scored = candidatesForReceipt(
      receiptModel,
      openTxModels,
      rejectedPairs,
      3
    );
    const byId = new Map(openTxs.map((tx) => [tx.id, tx]));
    const matchCandidates = scored
      .map((c) => {
        const tx = byId.get(c.transactionId);
        if (!tx) return null;
        return {
          ...toBankTxSummary(tx),
          score: c.score,
          reasons: c.reasons,
        };
      })
      .filter(
        (
          c
        ): c is BankTxMatchSummary & { score: number; reasons: string[] } =>
          c !== null
      );

    result.set(receipt.id, {
      status: "unlinked",
      linkedTransaction: null,
      suggestedTransaction: null,
      matchCandidates,
    });
  }

  return result;
}

/** Confirm a bank row ↔ receipt link (shared by API routes and auto-match). */
export async function confirmMatch(
  userId: string,
  transactionId: string,
  receiptId: string,
  fromSuggestion = false
): Promise<void> {
  const [tx, receipt] = await Promise.all([
    prisma.transaction.findFirst({
      where: { id: transactionId, statement: { userId } },
    }),
    prisma.receipt.findFirst({
      where: { id: receiptId, userId },
      include: { linkedTransaction: { select: { id: true } } },
    }),
  ]);
  if (!tx || !receipt) throw new MatchNotFoundError();
  if (receipt.linkedTransaction && receipt.linkedTransaction.id !== tx.id) {
    throw new MatchConflictError("Kuitti on jo linkitetty toiseen tapahtumaan");
  }

  await prisma.$transaction([
    prisma.transaction.updateMany({
      where: {
        suggestedReceiptId: receiptId,
        id: { not: transactionId },
        statement: { userId },
      },
      data: {
        matchStatus: "unmatched",
        suggestedReceiptId: null,
        matchScore: null,
        matchReasons: null,
      },
    }),
    prisma.transaction.update({
      where: { id: transactionId },
      data: {
        receiptId,
        matchStatus: "confirmed",
        suggestedReceiptId: null,
        ...(fromSuggestion
          ? {}
          : { matchScore: null, matchReasons: JSON.stringify(["manual"]) }),
      },
    }),
    prisma.receipt.update({
      where: { id: receiptId },
      data: { reviewStatus: "approved" },
    }),
  ]);
}

export class MatchNotFoundError extends Error {
  constructor() {
    super("Ei löytynyt");
    this.name = "MatchNotFoundError";
  }
}

export class MatchConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MatchConflictError";
  }
}

/** Confirm every pending suggestion for the user (optionally scoped). */
export async function confirmAllSuggestions(
  userId: string,
  scope?: { statementId?: string; periodMonth?: string }
): Promise<number> {
  const txs = await prisma.transaction.findMany({
    where: {
      matchStatus: "suggested",
      suggestedReceiptId: { not: null },
      statement: {
        userId,
        ...(scope?.statementId ? { id: scope.statementId } : {}),
        ...(scope?.periodMonth ? { periodMonth: scope.periodMonth } : {}),
      },
    },
    select: { id: true, suggestedReceiptId: true },
  });

  let count = 0;
  for (const tx of txs) {
    if (!tx.suggestedReceiptId) continue;
    await confirmMatch(userId, tx.id, tx.suggestedReceiptId, true);
    count += 1;
  }
  return count;
}

export interface RunMatchingResult {
  autoConfirmed: number;
  suggested: number;
}

/**
 * Recompute suggestions for one user across all their statements.
 *
 * Idempotent: confirmed and ignored transactions are never touched; existing
 * suggestions are replaced by the fresh greedy assignment; rejected pairs are
 * never re-proposed. Runs globally per user (data volumes are small) so
 * scoped triggers can't leave two transactions suggesting the same receipt.
 */
export async function runMatching(userId: string): Promise<RunMatchingResult> {
  const [rawTxs, rawReceipts, rejections] = await Promise.all([
    prisma.transaction.findMany({
      where: {
        statement: { userId },
        matchStatus: { in: ["unmatched", "suggested"] },
        type: { in: ["tulo", "meno"] },
      },
      select: {
        id: true,
        date: true,
        counterparty: true,
        amountCents: true,
        reference: true,
        message: true,
        type: true,
      },
    }),
    prisma.receipt.findMany({
      where: { userId, linkedTransaction: null },
      select: {
        id: true,
        vendor: true,
        date: true,
        totalAmountCents: true,
        type: true,
        reference: true,
        invoiceNumber: true,
        reviewStatus: true,
      },
    }),
    prisma.matchRejection.findMany({
      where: { transaction: { statement: { userId } } },
      select: { transactionId: true, receiptId: true },
    }),
  ]);

  const rejectedPairs = new Set(
    rejections.map((r) => pairKey(r.transactionId, r.receiptId))
  );
  const txs = rawTxs.map(({ amountCents, ...tx }) => ({
    ...tx,
    amount: centsToEuros(amountCents),
  }));
  const receipts = rawReceipts.map(({ totalAmountCents, ...receipt }) => ({
    ...receipt,
    totalAmount: totalAmountCents == null ? null : centsToEuros(totalAmountCents),
  }));
  const assignments = computeSuggestions(txs, receipts, rejectedPairs);

  // A pending document must never post automatically, however strong the match.
  // It can still be suggested — the user approves it in the review queue.
  const approvedReceiptIds = new Set(
    receipts.filter((r) => r.reviewStatus === "approved").map((r) => r.id)
  );
  const canAutoPost = (a: ScoredPair) =>
    shouldAutoConfirm(a.score, a.reasons) && approvedReceiptIds.has(a.receiptId);

  const autoPairs = assignments.filter(canAutoPost);
  const suggestPairs = assignments.filter((a) => !canAutoPost(a));

  const usedReceiptForAuto = new Set(autoPairs.map((a) => a.receiptId));
  const filteredSuggest = suggestPairs.filter(
    (a) =>
      !usedReceiptForAuto.has(a.receiptId) &&
      !autoPairs.some((auto) => auto.transactionId === a.transactionId)
  );

  await prisma.transaction.updateMany({
    where: { statement: { userId }, matchStatus: "suggested" },
    data: {
      matchStatus: "unmatched",
      suggestedReceiptId: null,
      matchScore: null,
      matchReasons: null,
    },
  });

  for (const pair of autoPairs) {
    try {
      await confirmMatch(userId, pair.transactionId, pair.receiptId, true);
    } catch (error) {
      console.error("Auto-confirm match failed:", error);
    }
  }

  if (filteredSuggest.length > 0) {
    await prisma.$transaction(
      filteredSuggest.map((a) =>
        prisma.transaction.update({
          where: { id: a.transactionId },
          data: {
            matchStatus: "suggested",
            suggestedReceiptId: a.receiptId,
            matchScore: a.score,
            matchReasons: JSON.stringify(a.reasons),
          },
        })
      )
    );
  }

  return { autoConfirmed: autoPairs.length, suggested: filteredSuggest.length };
}

export interface InlineMatchCandidate {
  score: number;
  reasons: string[];
  receipt: {
    id: string;
    vendor: string | null;
    date: Date | null;
    totalAmount: number | null;
    fileName: string;
  };
}

/** Top receipt picks for unmatched rows — shown inline so users skip manual search. */
export async function buildInlineCandidates(
  userId: string,
  txs: Array<{
    id: string;
    date: Date | null;
    counterparty: string | null;
    amountCents: number;
    reference: string | null;
    message: string | null;
    type: string;
    matchStatus: string;
  }>
): Promise<Map<string, InlineMatchCandidate[]>> {
  const unmatched = txs.filter(
    (t) => t.matchStatus === "unmatched" && t.type !== "oma_siirto" && t.type !== "palkka"
  );
  const result = new Map<string, InlineMatchCandidate[]>();
  if (unmatched.length === 0) return result;

  const [receipts, rejections] = await Promise.all([
    prisma.receipt.findMany({
      where: { userId, linkedTransaction: null },
      select: {
        id: true,
        vendor: true,
        date: true,
        totalAmountCents: true,
        type: true,
        reference: true,
        invoiceNumber: true,
        fileName: true,
      },
    }),
    prisma.matchRejection.findMany({
      where: { transaction: { statement: { userId } } },
      select: { transactionId: true, receiptId: true },
    }),
  ]);

  const rejectedPairs = new Set(
    rejections.map((r) => pairKey(r.transactionId, r.receiptId))
  );
  const receiptModels = receipts.map(({ totalAmountCents, ...receipt }) => ({
    ...receipt,
    totalAmount: totalAmountCents == null ? null : centsToEuros(totalAmountCents),
  }));
  const receiptById = new Map(receipts.map((r) => [r.id, r]));

  for (const tx of unmatched) {
    const scored = candidatesFor(
      { ...tx, amount: centsToEuros(tx.amountCents) },
      receiptModels,
      rejectedPairs,
      3
    );
    if (scored.length === 0) continue;
    result.set(
      tx.id,
      scored
        .map((c) => {
          const row = receiptById.get(c.receiptId);
          if (!row) return null;
          return {
            score: c.score,
            reasons: c.reasons,
            receipt: {
              id: row.id,
              vendor: row.vendor,
              date: row.date,
              totalAmount:
                row.totalAmountCents == null
                  ? null
                  : centsToEuros(row.totalAmountCents),
              fileName: row.fileName,
            },
          };
        })
        .filter((c): c is InlineMatchCandidate => c !== null)
    );
  }

  return result;
}
