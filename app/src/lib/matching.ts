// Relative import so standalone scripts (tsx) can load this module too
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "./db";
import { centsToEuros } from "./money";
import {
  AMBIGUOUS_REASON,
  decide,
  ELIGIBLE_MIN,
  gatePair,
  normalizeRef,
  planPairs,
  type GateCandidate,
  type GatedPair,
  type GateRow,
  type GateVerdict,
  type MatchKind,
} from "./match-gate";

import {
  cachedReviews,
  mergedReasons,
  prismaReviewCache,
  reviewKey,
  type ReviewCase,
  type StoredReview,
} from "./match-review";

export { nameSimilarity, normalizeRef } from "./match-gate";
import { assertPeriodOpen, PeriodLockedError } from "./period-lock";
import { parseVatDetails } from "./alv";

/**
 * Bank-transaction ↔ receipt matcher.
 *
 * The decision is deterministic (lib/match-gate.ts): a pair is suggested only
 * with hard evidence (exact amount plus viite, IBAN or a strong name match,
 * or a viite alone for a lasku), only when it is the clear best from both
 * sides, and dates only rank. An AI review (lib/match-review.ts) may later
 * veto or explain an uncertain pick; it never adds one the gate refused.
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
  /** Stable codes: viite, amount, iban, vendor, date, competing, ai. */
  reasons: string[];
  /** Short Finnish reasons for the owner ("viite täsmää", "summa sama"). */
  explanation?: string[];
  /** viite + exact amount. */
  certain?: boolean;
}

/** Lowest score of a pair the gate lets through (display default). */
export const SUGGEST_THRESHOLD = ELIGIBLE_MIN;
/** Anything below this is at most a search hit, never a suggestion. */
export const CANDIDATE_THRESHOLD = ELIGIBLE_MIN;
/** Strong matches link immediately without manual approval. */
export const AUTO_CONFIRM_THRESHOLD = 0.85;

/**
 * Evidence-based, not score-based. Posting to the books without a human needs
 * proof the pair belongs together, and only two signals together are proof:
 *
 *   viite  — the bank reference equals the receipt reference or invoice number
 *   amount — the amounts agree to the cent
 *
 * `competing` marks a pair that had another eligible rival, which means the
 * evidence is not decisive.
 */
export function shouldAutoConfirm(score: number, reasons: string[]): boolean {
  if (score < AUTO_CONFIRM_THRESHOLD) return false;
  if (reasons.includes("competing")) return false;
  return reasons.includes("viite") && reasons.includes("amount");
}

/** Euros (as the matcher models carry them) to whole cents, sign dropped. */
function toCents(euros: number): number {
  return Math.round(Math.abs(euros) * 100);
}

/** A receipt with a viite or an invoice number is a lasku (paid on terms). */
function receiptKind(receipt: MatchReceipt): MatchKind {
  return normalizeRef(receipt.reference) || normalizeRef(receipt.invoiceNumber) ? "lasku" : "kuitti";
}

export function txToGateRow(tx: MatchTx): GateRow {
  return {
    id: tx.id,
    date: tx.date,
    amountCents: toCents(tx.amount),
    counterparty: tx.counterparty,
    reference: tx.reference,
    message: tx.message,
  };
}

export function receiptToGateCandidate(receipt: MatchReceipt): GateCandidate {
  return {
    id: receipt.id,
    kind: receiptKind(receipt),
    date: receipt.date,
    amountCents: receipt.totalAmount == null ? null : toCents(receipt.totalAmount),
    party: receipt.vendor,
    reference: receipt.reference,
    invoiceNumber: receipt.invoiceNumber,
  };
}

/** Money direction must agree; transfers and salaries never match a receipt. */
function directionAllowed(tx: MatchTx, receipt: MatchReceipt): boolean {
  if (tx.type !== "tulo" && tx.type !== "meno") return false;
  return receipt.type === tx.type;
}

export interface PairScore {
  score: number;
  reasons: string[];
  explanation: string[];
  eligible: boolean;
  certain: boolean;
  verdict: GateVerdict;
}

/** Score one tx↔receipt pair. Returns null when the direction gate refuses it. */
export function scorePair(tx: MatchTx, receipt: MatchReceipt): PairScore | null {
  if (!directionAllowed(tx, receipt)) return null;
  const verdict = gatePair(txToGateRow(tx), receiptToGateCandidate(receipt));
  return {
    score: verdict.score,
    reasons: verdict.codes,
    explanation: verdict.reasons,
    eligible: verdict.eligible,
    certain: verdict.certain,
    verdict,
  };
}

function pairKey(transactionId: string, receiptId: string): string {
  return `${transactionId}:${receiptId}`;
}

function toScored(pair: GatedPair, competing: boolean): ScoredPair {
  return {
    transactionId: pair.rowId,
    receiptId: pair.candidateId,
    score: pair.verdict.score,
    reasons: competing ? [...pair.verdict.codes, "competing"] : [...pair.verdict.codes],
    explanation: [...pair.verdict.reasons],
    certain: pair.verdict.certain,
  };
}

export interface ReceiptPlan {
  /** Pairs to suggest (or auto-confirm when certain and uncontested). */
  picks: ScoredPair[];
  /** Rows whose best receipts tie: listed for the owner, never suggested. */
  ambiguous: Map<string, ScoredPair[]>;
  /** Every eligible pair per row, best first. */
  eligibleByRow: Map<string, ScoredPair[]>;
}

/** The gate's plan over rows and receipts (rejected pairs and wrong directions left out). */
export function planReceiptPairs(
  txs: MatchTx[],
  receipts: MatchReceipt[],
  rejectedPairs: Set<string>
): ReceiptPlan {
  const txById = new Map(txs.map((tx) => [tx.id, tx]));
  const receiptById = new Map(receipts.map((r) => [r.id, r]));
  const plan = planPairs(
    txs.map(txToGateRow),
    receipts.map(receiptToGateCandidate),
    (rowId, candidateId) =>
      !rejectedPairs.has(pairKey(rowId, candidateId)) &&
      directionAllowed(txById.get(rowId)!, receiptById.get(candidateId)!)
  );
  // A rival on either side (another eligible receipt for the row, another
  // eligible row for the receipt) keeps a certain pair from posting by itself.
  const rowsPerReceipt = new Map<string, number>();
  for (const pairs of plan.eligibleByRow.values()) {
    for (const pair of pairs) rowsPerReceipt.set(pair.candidateId, (rowsPerReceipt.get(pair.candidateId) ?? 0) + 1);
  }
  const competing = (pair: GatedPair) =>
    (plan.eligibleByRow.get(pair.rowId)?.length ?? 0) > 1 || (rowsPerReceipt.get(pair.candidateId) ?? 0) > 1;
  return {
    picks: plan.picks.map((pair) => toScored(pair, competing(pair))),
    ambiguous: new Map(
      [...plan.ambiguousRows].map(([rowId, pairs]) => [
        rowId,
        pairs.map((pair) => ({ ...toScored(pair, true), explanation: [...pair.verdict.reasons, AMBIGUOUS_REASON] })),
      ])
    ),
    eligibleByRow: new Map(
      [...plan.eligibleByRow].map(([rowId, pairs]) => [rowId, pairs.map((pair) => toScored(pair, pairs.length > 1))])
    ),
  };
}

/**
 * The pairs to suggest: each eligible pair that is the clear best from both
 * sides. Two equally plausible receipts (or rows) give no suggestion at all.
 */
export function computeSuggestions(
  txs: MatchTx[],
  receipts: MatchReceipt[],
  rejectedPairs: Set<string>
): ScoredPair[] {
  return planReceiptPairs(txs, receipts, rejectedPairs).picks;
}

/**
 * Shortlist for one bank row. `suggest` (inline picks, the chat) lists only
 * gate-eligible receipts, ties marked `competing`. `search` ("Etsi kuitti",
 * the owner looking by hand) adds related receipts (same amount, a viite, or
 * the same name within the date window) after them, never date-only ones.
 */
export function candidatesFor(
  tx: MatchTx,
  receipts: MatchReceipt[],
  rejectedPairs: Set<string>,
  limit = 5,
  mode: "suggest" | "search" = "suggest"
): ScoredPair[] {
  const scored: Array<ScoredPair & { eligible: boolean }> = [];
  for (const receipt of receipts) {
    if (rejectedPairs.has(pairKey(tx.id, receipt.id))) continue;
    const result = scorePair(tx, receipt);
    if (!result) continue;
    if (!result.eligible && (mode === "suggest" || result.score <= 0)) continue;
    scored.push({
      transactionId: tx.id,
      receiptId: receipt.id,
      score: result.score,
      reasons: result.reasons,
      explanation: result.explanation,
      certain: result.certain,
      eligible: result.eligible,
    });
  }
  const decision = decide(scored.filter((s) => s.eligible).map((s) => ({ ...s, certain: Boolean(s.certain) })));
  const tied = new Set(decision.ambiguous.map((s) => s.receiptId));
  const eligibleCount = decision.eligible.length;
  return scored
    .sort((a, b) => Number(b.eligible) - Number(a.eligible) || Number(b.certain) - Number(a.certain) || b.score - a.score)
    .slice(0, limit)
    .map(({ eligible, ...pair }) => {
      if (!eligible) return pair;
      if (tied.has(pair.receiptId)) {
        return { ...pair, reasons: [...pair.reasons, "competing"], explanation: [...(pair.explanation ?? []), AMBIGUOUS_REASON] };
      }
      return eligibleCount > 1 ? { ...pair, reasons: [...pair.reasons, "competing"] } : pair;
    });
}

/**
 * Bank rows for one receipt ("which bank row fits this kuitti?"). `suggest` (the chat's one
 * proposal) lists only gate-eligible rows. `search` (the receipt screen, the owner choosing by
 * hand) adds related rows after them: the same amount, a viite or the same name within the date
 * window, as "Etsi kuitti" does from the bank side. Without it a receipt whose bank row had the
 * exact amount but a different-looking name (ABC Prisma vs "KSO ABC Sahkonlata") listed nothing.
 */
export function candidatesForReceipt(
  receipt: MatchReceipt,
  txs: MatchTx[],
  rejectedPairs: Set<string>,
  limit = 3,
  mode: "suggest" | "search" = "suggest"
): ScoredPair[] {
  const scored: Array<ScoredPair & { eligible: boolean }> = [];
  for (const tx of txs) {
    if (rejectedPairs.has(pairKey(tx.id, receipt.id))) continue;
    const result = scorePair(tx, receipt);
    if (!result) continue;
    if (!result.eligible && (mode === "suggest" || result.score <= 0)) continue;
    scored.push({
      transactionId: tx.id,
      receiptId: receipt.id,
      score: result.score,
      reasons: result.reasons,
      explanation: result.explanation,
      certain: result.certain,
      eligible: result.eligible,
    });
  }
  const decision = decide(scored.filter((s) => s.eligible).map((s) => ({ ...s, certain: Boolean(s.certain) })));
  const tied = new Set(decision.ambiguous.map((s) => s.transactionId));
  const eligibleCount = decision.eligible.length;
  const strip = ({ eligible: _eligible, ...pair }: ScoredPair & { eligible: boolean }): ScoredPair => pair;
  const eligible = decision.eligible.map((pair) => {
    const plain = strip(pair as ScoredPair & { eligible: boolean });
    if (tied.has(plain.transactionId)) {
      return { ...plain, reasons: [...plain.reasons, "competing"], explanation: [...(plain.explanation ?? []), AMBIGUOUS_REASON] };
    }
    return eligibleCount > 1 ? { ...plain, reasons: [...plain.reasons, "competing"] } : plain;
  });
  const related = scored
    .filter((s) => !s.eligible)
    .sort((a, b) => b.score - a.score)
    .map(strip);
  return [...eligible, ...related].slice(0, limit);
}

/** The one pick a shortlist allows: its best entry, unless that entry ties with another. */
export function unambiguousBest(list: ScoredPair[]): ScoredPair | null {
  const [best] = list;
  if (!best) return null;
  return best.explanation?.includes(AMBIGUOUS_REASON) ? null : best;
}

/* ------------------------- stored reasons ------------------------- */

const FI_PREFIX = "fi:";

/** Transaction.matchReasons: the codes, then the Finnish reasons as "fi:" entries
 *  (the web shows labels for known codes and skips the rest). */
export function encodeMatchReasons(codes: string[], explanation: string[] = []): string {
  return JSON.stringify([...codes, ...explanation.map((text) => `${FI_PREFIX}${text}`)]);
}

/** The Finnish reasons stored on a row, for "Miksi: …". */
export function matchExplanation(reasons: string[] | null | undefined): string[] {
  return (reasons ?? []).filter((r) => r.startsWith(FI_PREFIX)).map((r) => r.slice(FI_PREFIX.length));
}

/** The stable codes stored on a row, without the Finnish reasons. */
export function matchCodes(reasons: string[] | null | undefined): string[] {
  return (reasons ?? []).filter((r) => !r.startsWith(FI_PREFIX));
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

/**
 * Match state per receipt for list/detail UI (linked, suggested, or top picks).
 *
 * The receipt list passes `candidates: false`. Scoring every open bank row
 * against every row on the page is the expensive part, and the list only
 * needs the stored link or suggestion. Opening one receipt (or expanding it)
 * passes the default and computes that receipt's shortlist.
 */
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
  }>,
  options?: { candidates?: boolean }
): Promise<Map<string, ReceiptMatchView>> {
  const result = new Map<string, ReceiptMatchView>();
  if (receipts.length === 0) return result;

  const includeCandidates = options?.candidates !== false;
  const receiptIds = receipts.map((r) => r.id);
  const needsCandidates = includeCandidates
    ? receipts.filter((r) => !r.linkedTransaction)
    : [];

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
    includeCandidates
      ? prisma.matchRejection.findMany({
          where: { receiptId: { in: receiptIds } },
          select: { transactionId: true, receiptId: true },
        })
      : Promise.resolve([]),
  ]);
  const draftSource = new Map(
    needsCandidates.length > 0
      ? (
          await prisma.receipt.findMany({
            where: { id: { in: needsCandidates.map((r) => r.id) }, userId, source: "auto_income" },
            select: { id: true, sourceTransactionId: true },
          })
        ).flatMap((r) => (r.sourceTransactionId ? [[r.id, r.sourceTransactionId] as const] : []))
      : []
  );

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
    // An income draft only ever fits the bank row it was made from.
    const sourceTxId = draftSource.get(receipt.id);
    const scored = candidatesForReceipt(
      receiptModel,
      sourceTxId ? openTxModels.filter((tx) => tx.id === sourceTxId) : openTxModels,
      rejectedPairs,
      5,
      "search"
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

type MatchWriter = Prisma.TransactionClient | typeof prisma;

/** Confirm a bank row ↔ receipt link (shared by API routes and auto-match). */
export async function confirmMatch(
  userId: string,
  transactionId: string,
  receiptId: string,
  fromSuggestion = false,
  db: MatchWriter = prisma
): Promise<void> {
  // Read, check and write in one transaction: a period closed (or a receipt
  // linked elsewhere) between the check and the write cannot slip through.
  const run = async (client: MatchWriter) => {
    const [tx, receipt] = await Promise.all([
      client.transaction.findFirst({
        where: { id: transactionId, statement: { userId } },
      }),
      client.receipt.findFirst({
        where: { id: receiptId, userId },
        include: { linkedTransaction: { select: { id: true } } },
      }),
    ]);
    if (!tx || !receipt) throw new MatchNotFoundError();
    if (receipt.linkedTransaction && receipt.linkedTransaction.id !== tx.id) {
      throw new MatchConflictError("Kuitti on jo kohdistettu toiseen tapahtumaan");
    }
    // The row's own receipt stays: a second one took the row and left the first approved without
    // its bank row (audit 2026-10-09). Unlinking first is the way to change it.
    if (tx.receiptId && tx.receiptId !== receipt.id) {
      throw new MatchConflictError("Tapahtuma on jo kohdistettu toiseen kuittiin. Poista ensin se kohdistus.");
    }
    // Confirming approves a waiting receipt, which moves its month's VAT return
    // and report exactly as approving it from the review queue does.
    if (receipt.reviewStatus !== "approved") await assertPeriodOpen(userId, [receipt.date], client);

    await client.automationEvent.create({
      data: {
        userId,
        kind: "match",
        resourceType: "transaction",
        resourceId: transactionId,
        previousValue: tx.matchStatus,
        newValue: "confirmed",
        reason: fromSuggestion ? "automaattinen kohdistus" : "käyttäjän vahvistus",
      },
    });
    await client.transaction.updateMany({
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
    });
    await client.transaction.update({
      where: { id: transactionId },
      data: {
        receiptId,
        matchStatus: "confirmed",
        suggestedReceiptId: null,
        ...(fromSuggestion
          ? {}
          : { matchScore: null, matchReasons: JSON.stringify(["manual"]) }),
      },
    });
    await client.receipt.update({
      where: { id: receiptId },
      data: { reviewStatus: "approved", ...bankEuroAmount(receipt, tx.amountCents) },
    });
  };

  if (db === prisma) {
    await prisma.$transaction(async (txClient) => {
      await run(txClient);
    });
    return;
  }
  await run(db);
}

/**
 * A receipt in another currency is booked at what the bank actually charged in
 * euros: the original amount stays in `originalAmountCents`, VAT lines follow
 * the new total. Nothing changes for a euro receipt.
 */
export function bankEuroAmount(
  receipt: { currency: string; totalAmountCents: number | null; originalAmountCents: number | null; vatDetails: string | null },
  bankAmountCents: number
): { totalAmountCents?: number; originalAmountCents?: number; vatDetails?: string } {
  if (receipt.currency === "EUR") return {};
  const euros = Math.abs(bankAmountCents);
  const previous = receipt.totalAmountCents;
  const out: { totalAmountCents: number; originalAmountCents?: number; vatDetails?: string } = { totalAmountCents: euros };
  if (receipt.originalAmountCents == null && previous != null) out.originalAmountCents = previous;
  const lines = parseVatDetails(receipt.vatDetails);
  if (lines && previous && previous > 0) {
    out.vatDetails = JSON.stringify(
      lines.map((line) => ({ rate: line.rate, amount: Math.round((line.amountCents * euros) / previous) / 100 }))
    );
  }
  return out;
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
      // Income drafts are approved one by one with "Hyväksy" (batch-approve
      // checks the amount); a bulk link must never approve them silently.
      suggestedReceipt: { source: { not: "auto_income" } },
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
    try {
      await confirmMatch(userId, tx.id, tx.suggestedReceiptId, true);
    } catch (error) {
      // A receipt of a closed month stays a suggestion; the rest still go through.
      if (error instanceof PeriodLockedError) continue;
      throw error;
    }
    count += 1;
  }
  return count;
}

/** An automatic income draft that knows the bank row it was made from. */
export function isSourceDraft(receipt: {
  source?: string | null;
  sourceTransactionId?: string | null;
}): boolean {
  return receipt.source === "auto_income" && !!receipt.sourceTransactionId;
}

export const SOURCE_DRAFT_REASONS = ["auto_income"];

/**
 * Prisma filter: receipts that may be offered to a bank row as a candidate.
 * Income drafts are left out, except the one made from `ownRowId` itself.
 */
export function offerableReceiptWhere(ownRowId?: string) {
  return {
    OR: [
      { source: { not: "auto_income" } },
      { sourceTransactionId: null },
      ...(ownRowId ? [{ sourceTransactionId: ownRowId }] : []),
    ],
  };
}

/**
 * Each income draft paired with its own source row, when that row is still
 * open and the user has not rejected the pair ("Ei myyntiä").
 */
export function sourceDraftPairs(
  txs: Array<{ id: string }>,
  receipts: Array<{
    id: string;
    source?: string | null;
    sourceTransactionId?: string | null;
    reviewStatus?: string | null;
  }>,
  rejectedPairs: Set<string>
): ScoredPair[] {
  const openTx = new Set(txs.map((tx) => tx.id));
  const pairs: ScoredPair[] = [];
  for (const receipt of receipts) {
    if (!isSourceDraft(receipt)) continue;
    // A rejected draft is not a sale to offer: "Hyväksy" on it could only fail.
    if (receipt.reviewStatus === "rejected") continue;
    const txId = receipt.sourceTransactionId!;
    if (!openTx.has(txId) || rejectedPairs.has(pairKey(txId, receipt.id))) continue;
    pairs.push({
      transactionId: txId,
      receiptId: receipt.id,
      score: 1,
      reasons: [...SOURCE_DRAFT_REASONS],
    });
  }
  return pairs;
}

/** The AI review question for a row's pick: the row and its eligible receipts, the pick first. */
export function receiptReviewCase(
  tx: MatchTx,
  pick: ScoredPair,
  eligible: ScoredPair[],
  receiptById: Map<string, MatchReceipt>
): ReviewCase {
  const ordered = [pick, ...eligible.filter((p) => p.receiptId !== pick.receiptId)].slice(0, 3);
  return {
    target: "receipt",
    row: {
      id: tx.id,
      date: isoDay(tx.date),
      amount: tx.amount.toFixed(2),
      counterparty: tx.counterparty,
      message: tx.message,
      reference: tx.reference,
    },
    candidates: ordered.flatMap((pair) => {
      const receipt = receiptById.get(pair.receiptId);
      if (!receipt) return [];
      return [{
        id: receipt.id,
        kind: receiptToGateCandidate(receipt).kind,
        date: isoDay(receipt.date),
        dueDate: null,
        amount: receipt.totalAmount == null ? "?" : receipt.totalAmount.toFixed(2),
        open: null,
        party: receipt.vendor,
        reference: receipt.reference,
        invoiceNumber: receipt.invoiceNumber,
        gateReasons: pair.explanation ?? [],
      }];
    }),
    gatePickId: pick.receiptId,
  };
}

function isoDay(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

/** The plan's picks with cached AI reviews applied: vetoed ones dropped, confirmed ones explained. */
async function applyReviews(
  userId: string,
  plan: ReceiptPlan,
  txs: MatchTx[],
  receipts: MatchReceipt[]
): Promise<ScoredPair[]> {
  const uncertain = plan.picks.filter((p) => !p.certain);
  if (uncertain.length === 0) return plan.picks;
  const txById = new Map(txs.map((tx) => [tx.id, tx]));
  const receiptById = new Map(receipts.map((r) => [r.id, r]));
  const cases = new Map(
    uncertain.map((pick) => [
      pick,
      receiptReviewCase(txById.get(pick.transactionId)!, pick, plan.eligibleByRow.get(pick.transactionId) ?? [pick], receiptById),
    ])
  );
  let reviews: Map<string, StoredReview>;
  try {
    reviews = await cachedReviews(prismaReviewCache(userId), [...cases.values()]);
  } catch (error) {
    // The review is advisory: without it the gate's own picks stand.
    console.error("Reading match reviews failed:", error);
    return plan.picks;
  }
  return plan.picks.flatMap((pick) => {
    const item = cases.get(pick);
    if (!item) return [pick];
    const review = reviews.get(reviewKey(item));
    if (!review) return [pick];
    if (!review.accepted) return [];
    return [{
      ...pick,
      reasons: [...pick.reasons, "ai"],
      explanation: mergedReasons(pick.explanation ?? [], review),
    }];
  });
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
/** Open bank rows, unlinked receipts and rejected pairs: what the matcher works on. */
export async function loadMatchingInputs(userId: string) {
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
        matchStatus: true,
        suggestedReceiptId: true,
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
        source: true,
        sourceTransactionId: true,
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
  const allTxs = rawTxs.map(({ amountCents, ...tx }) => ({
    ...tx,
    amount: centsToEuros(amountCents),
  }));
  const allReceipts = rawReceipts.map(({ totalAmountCents, ...receipt }) => ({
    ...receipt,
    totalAmount: totalAmountCents == null ? null : centsToEuros(totalAmountCents),
  }));
  return { allTxs, allReceipts, rejectedPairs };
}

export async function runMatching(userId: string): Promise<RunMatchingResult> {
  const { allTxs, allReceipts, rejectedPairs } = await loadMatchingInputs(userId);

  // An income draft was made from one bank row, so that row is its only match.
  // Scoring it against every row made all MobilePay drafts (same vendor) rivals
  // for all MobilePay rows, and the user had to pick from three look-alikes.
  // A real document still wins the row; the draft only fills an empty one.
  const receipts = allReceipts.filter((r) => !isSourceDraft(r));
  const plan = planReceiptPairs(allTxs, receipts, rejectedPairs);
  // An uncertain pick the AI review vetoed for exactly this question is not
  // suggested again; one it confirmed carries its reasons too.
  const documentPairs = await applyReviews(userId, plan, allTxs, receipts);
  const takenTx = new Set(documentPairs.map((p) => p.transactionId));
  const assignments = [
    ...documentPairs,
    ...sourceDraftPairs(
      allTxs.filter((tx) => !takenTx.has(tx.id)),
      allReceipts,
      rejectedPairs
    ),
  ];

  // A pending document must never post automatically, however strong the match.
  // It can still be suggested — the user approves it in the review queue.
  const approvedReceiptIds = new Set(
    receipts.filter((r) => r.reviewStatus === "approved").map((r) => r.id)
  );
  // An income draft that is already approved is booked: its own open row is not
  // a question ("Hyväksy" would fail, the draft is no longer pending), so the
  // two are simply linked again.
  const approvedDraftIds = new Set(
    allReceipts.filter((r) => isSourceDraft(r) && r.reviewStatus === "approved").map((r) => r.id)
  );
  const canAutoPost = (a: ScoredPair) =>
    (shouldAutoConfirm(a.score, a.reasons) && approvedReceiptIds.has(a.receiptId)) ||
    (approvedDraftIds.has(a.receiptId) && a.reasons.includes(SOURCE_DRAFT_REASONS[0]));

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
            matchReasons: encodeMatchReasons(a.reasons, a.explanation),
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
  /** Finnish "Miksi" reasons ("summa sama", "nimi vastaa", "veloitettu 2 päivää oston jälkeen"). */
  explanation: string[];
  receipt: {
    id: string;
    vendor: string | null;
    date: Date | null;
    totalAmount: number | null;
    fileName: string;
  };
}

/**
 * Gate-eligible receipt picks for unmatched rows, shown inline so users skip
 * manual search. Never a date-only or vendor-only pick; a pick the AI review
 * vetoed is left out; two equally plausible receipts are both listed, marked
 * for the owner to choose.
 */
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
      // Income drafts are paired with their own row by runMatching; offering
      // them to other rows is what produced three look-alike MobilePay picks.
      where: { userId, linkedTransaction: null, ...offerableReceiptWhere() },
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
  const receiptModels: MatchReceipt[] = receipts.map(({ totalAmountCents, ...receipt }) => ({
    ...receipt,
    totalAmount: totalAmountCents == null ? null : centsToEuros(totalAmountCents),
  }));
  const receiptById = new Map(receipts.map((r) => [r.id, r]));
  const modelById = new Map(receiptModels.map((r) => [r.id, r]));

  const lists = new Map<string, ScoredPair[]>();
  const cases: Array<{ txId: string; pick: ScoredPair; item: ReviewCase }> = [];
  for (const tx of unmatched) {
    const model: MatchTx = { ...tx, amount: centsToEuros(tx.amountCents) };
    const scored = candidatesFor(model, receiptModels, rejectedPairs, 3);
    if (scored.length === 0) continue;
    lists.set(tx.id, scored);
    const best = unambiguousBest(scored);
    if (best && !best.certain) cases.push({ txId: tx.id, pick: best, item: receiptReviewCase(model, best, scored, modelById) });
  }

  if (cases.length > 0) {
    try {
      const reviews = await cachedReviews(prismaReviewCache(userId), cases.map((c) => c.item));
      for (const { txId, pick, item } of cases) {
        const review = reviews.get(reviewKey(item));
        if (!review) continue;
        const list = lists.get(txId)!;
        lists.set(
          txId,
          review.accepted
            ? list.map((c) => (c === pick ? { ...c, explanation: mergedReasons(c.explanation ?? [], review) } : c))
            : list.filter((c) => c !== pick)
        );
      }
    } catch (error) {
      console.error("Reading match reviews failed:", error);
    }
  }

  for (const [txId, scored] of lists) {
    const candidates = scored.flatMap((c) => {
      const row = receiptById.get(c.receiptId);
      if (!row) return [];
      return [{
        score: c.score,
        reasons: c.reasons,
        explanation: c.explanation ?? [],
        receipt: {
          id: row.id,
          vendor: row.vendor,
          date: row.date,
          totalAmount: row.totalAmountCents == null ? null : centsToEuros(row.totalAmountCents),
          fileName: row.fileName,
        },
      }];
    });
    if (candidates.length > 0) result.set(txId, candidates);
  }

  return result;
}
