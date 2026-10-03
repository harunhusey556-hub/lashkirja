/**
 * The match review as a run: the gate's picks over the owner's open bank rows
 * (receipts and sales invoices), the AI review of the uncertain ones, and the
 * stored suggestions brought in line with the verdicts. Called on demand (the
 * chat's review_matches tool) and by the background worker after a sync;
 * never inside a sync itself, so a slow or absent model never blocks one.
 *
 * Nothing here posts to the books: a review can only explain a suggestion or
 * withdraw it. Confirming stays the owner's tap.
 */
import { prisma } from "./db";
import { askReasoned, chatProviderConfigured } from "./chat-provider";
import {
  encodeMatchReasons,
  isSourceDraft,
  loadMatchingInputs,
  planReceiptPairs,
  receiptReviewCase,
  type ScoredPair,
} from "./matching";
import { planInvoicePaymentSuggestions, salesReviewCase } from "./sales-invoices";
import { getLockedThrough, isDateLocked } from "./period-lock";
import {
  mergedReasons,
  prismaReviewCache,
  REVIEW_DEFAULTS,
  reviewCases,
  type MatchJudge,
  type ReviewCache,
  type ReviewCase,
  type ReviewOutcome,
} from "./match-review";

/** The review runs when a model is configured, unless MATCH_AI_REVIEW=off. */
export function matchReviewEnabled(): boolean {
  return process.env.MATCH_AI_REVIEW?.trim().toLowerCase() !== "off" && chatProviderConfigured();
}

/** The configured model as a judge (thinking on when the model takes it), or null. */
export function defaultMatchJudge(): MatchJudge | null {
  if (!matchReviewEnabled()) return null;
  return (system, user, signal) => askReasoned(system, user, { signal });
}

export type ReviewedStatus = "certain" | "ai_accepted" | "ai_rejected" | "unreviewed";

export interface ReviewedMatch {
  target: "receipt" | "sales_invoice";
  transactionId: string;
  candidateId: string;
  status: ReviewedStatus;
  /** Certain (viite + amount) or confirmed by the AI review: may be offered. */
  passed: boolean;
  score: number;
  /** The model's confidence, when it answered. */
  confidence: number | null;
  /** Finnish "Miksi" reasons. */
  reasons: string[];
  row: { date: Date | null; amountCents: number; counterparty: string | null; message: string | null };
  candidate: {
    label: string;
    date: Date | null;
    amountCents: number | null;
    fileName: string | null;
    invoiceNumber: number | null;
  };
}

export interface AmbiguousRow {
  target: "receipt" | "sales_invoice";
  transactionId: string;
  row: { date: Date | null; amountCents: number; counterparty: string | null };
  options: Array<{ candidateId: string; label: string; reasons: string[] }>;
}

export interface MatchReviewReport {
  aiAvailable: boolean;
  matches: ReviewedMatch[];
  ambiguous: AmbiguousRow[];
  /** Answered by the model on this run. */
  reviewedNow: number;
  /** Answered earlier for the same question. */
  fromCache: number;
  /** Uncertain picks no review covers yet (no model, budget or time spent). */
  unreviewed: number;
}

export interface ReviewRunOptions {
  /** Only bank rows dated in this month (YYYY-MM). */
  month?: string;
  judge?: MatchJudge | null;
  cache?: ReviewCache;
  maxCalls?: number;
  concurrency?: number;
  deadlineMs?: number;
}

function inMonth(date: Date | null, month: string | undefined): boolean {
  if (!month) return true;
  return Boolean(date && date.toISOString().slice(0, 7) === month);
}

const cents = (euros: number) => Math.round(euros * 100);

export async function reviewOpenMatches(userId: string, options: ReviewRunOptions = {}): Promise<MatchReviewReport> {
  const judge = options.judge === undefined ? defaultMatchJudge() : options.judge;
  const cache = options.cache ?? prismaReviewCache(userId);

  /* ---------------------------- receipts ---------------------------- */
  const { allTxs, allReceipts, rejectedPairs } = await loadMatchingInputs(userId);
  const receipts = allReceipts.filter((receipt) => !isSourceDraft(receipt));
  const receiptById = new Map(receipts.map((receipt) => [receipt.id, receipt]));
  const fileNames = new Map(
    (
      await prisma.receipt.findMany({
        where: { userId, id: { in: receipts.map((r) => r.id) } },
        select: { id: true, fileName: true },
      })
    ).map((r) => [r.id, r.fileName])
  );
  const txById = new Map(allTxs.map((tx) => [tx.id, tx]));
  const plan = planReceiptPairs(allTxs, receipts, rejectedPairs);
  const receiptPicks = plan.picks.filter((pick) => inMonth(txById.get(pick.transactionId)?.date ?? null, options.month));

  /* -------------------------- sales invoices -------------------------- */
  const [openInvoices, incoming, lockedThrough] = await Promise.all([
    prisma.salesInvoice.findMany({
      where: { userId, status: "sent", documentKind: "invoice" },
      select: {
        id: true,
        number: true,
        reference: true,
        issueDate: true,
        dueDate: true,
        grossCents: true,
        payments: { select: { amountCents: true } },
        customer: { select: { name: true } },
      },
    }),
    prisma.transaction.findMany({
      where: { statement: { userId }, amountCents: { gt: 0 }, invoicePayment: null },
      select: { id: true, amountCents: true, date: true, reference: true, message: true, counterparty: true },
    }),
    getLockedThrough(userId),
  ]);
  const salesPlan = planInvoicePaymentSuggestions(
    incoming.filter((row) => !row.date || !isDateLocked(lockedThrough, row.date.toISOString().slice(0, 10))),
    openInvoices
  );
  const salesPicks = salesPlan.picks.filter((pick) => inMonth(pick.transaction.date, options.month));

  /* ----------------------------- review ----------------------------- */
  const receiptCases = new Map<ScoredPair, ReviewCase>();
  for (const pick of receiptPicks) {
    if (pick.certain) continue;
    receiptCases.set(
      pick,
      receiptReviewCase(txById.get(pick.transactionId)!, pick, plan.eligibleByRow.get(pick.transactionId) ?? [pick], receiptById)
    );
  }
  const salesCases = new Map<(typeof salesPicks)[number], ReviewCase>();
  for (const pick of salesPicks) {
    if (pick.verdict.certain) continue;
    salesCases.set(pick, salesReviewCase(pick, salesPlan.eligibleByRow.get(pick.transaction.id)));
  }
  const cases = [...receiptCases.values(), ...salesCases.values()];
  const outcomes = await reviewCases(cases, {
    judge,
    cache,
    maxCalls: options.maxCalls ?? REVIEW_DEFAULTS.maxCalls,
    concurrency: options.concurrency ?? REVIEW_DEFAULTS.concurrency,
    deadlineMs: options.deadlineMs ?? REVIEW_DEFAULTS.deadlineMs,
  });
  const outcomeOf = new Map<ReviewCase, ReviewOutcome>(outcomes.map((o) => [o.case, o]));

  const statusOf = (outcome: ReviewOutcome | undefined, certain: boolean): ReviewedStatus => {
    if (certain) return "certain";
    if (!outcome || outcome.status === "unreviewed") return "unreviewed";
    return outcome.status === "accepted" ? "ai_accepted" : "ai_rejected";
  };

  const matches: ReviewedMatch[] = [];
  for (const pick of receiptPicks) {
    const tx = txById.get(pick.transactionId)!;
    const receipt = receiptById.get(pick.receiptId)!;
    const item = receiptCases.get(pick);
    const outcome = item ? outcomeOf.get(item) : undefined;
    const status = statusOf(outcome, Boolean(pick.certain));
    const gateReasons = pick.explanation ?? [];
    matches.push({
      target: "receipt",
      transactionId: tx.id,
      candidateId: receipt.id,
      status,
      passed: status === "certain" || status === "ai_accepted",
      score: pick.score,
      confidence: outcome?.review?.confidence ?? null,
      reasons: status === "ai_rejected" ? outcome?.review?.reasons ?? [] : mergedReasons(gateReasons, outcome?.review ?? null),
      row: { date: tx.date, amountCents: cents(tx.amount), counterparty: tx.counterparty, message: tx.message },
      candidate: {
        label: receipt.vendor || fileNames.get(receipt.id) || "Kuitti",
        date: receipt.date,
        amountCents: receipt.totalAmount == null ? null : cents(receipt.totalAmount),
        fileName: fileNames.get(receipt.id) ?? null,
        invoiceNumber: null,
      },
    });
  }
  for (const pick of salesPicks) {
    const item = salesCases.get(pick);
    const outcome = item ? outcomeOf.get(item) : undefined;
    const status = statusOf(outcome, pick.verdict.certain);
    matches.push({
      target: "sales_invoice",
      transactionId: pick.transaction.id,
      candidateId: pick.invoice.id,
      status,
      passed: status === "certain" || status === "ai_accepted",
      score: pick.verdict.score,
      confidence: outcome?.review?.confidence ?? null,
      reasons: status === "ai_rejected" ? outcome?.review?.reasons ?? [] : mergedReasons(pick.verdict.reasons, outcome?.review ?? null),
      row: {
        date: pick.transaction.date,
        amountCents: pick.transaction.amountCents,
        counterparty: pick.transaction.counterparty,
        message: pick.transaction.message,
      },
      candidate: {
        label: `Lasku ${pick.invoice.number} · ${pick.invoice.customer.name}`,
        date: pick.invoice.dueDate,
        amountCents: pick.invoice.grossCents,
        fileName: null,
        invoiceNumber: pick.invoice.number,
      },
    });
  }

  /* ------------- stored suggestions follow the verdicts ------------- */
  for (const match of matches) {
    if (match.target !== "receipt" || match.status === "certain" || match.status === "unreviewed") continue;
    const pick = receiptPicks.find((p) => p.transactionId === match.transactionId && p.receiptId === match.candidateId)!;
    const where = {
      id: match.transactionId,
      matchStatus: "suggested",
      suggestedReceiptId: match.candidateId,
      statement: { userId },
    };
    if (match.status === "ai_rejected") {
      await prisma.transaction.updateMany({
        where,
        data: { matchStatus: "unmatched", suggestedReceiptId: null, matchScore: null, matchReasons: null },
      });
    } else {
      await prisma.transaction.updateMany({
        where,
        data: { matchReasons: encodeMatchReasons([...pick.reasons, "ai"], match.reasons) },
      });
    }
  }

  /* ---------------------------- ambiguity ---------------------------- */
  const ambiguous: AmbiguousRow[] = [];
  for (const [rowId, pairs] of plan.ambiguous) {
    const tx = txById.get(rowId);
    if (!tx || !inMonth(tx.date, options.month)) continue;
    ambiguous.push({
      target: "receipt",
      transactionId: rowId,
      row: { date: tx.date, amountCents: cents(tx.amount), counterparty: tx.counterparty },
      options: pairs.map((pair) => {
        const receipt = receiptById.get(pair.receiptId);
        return {
          candidateId: pair.receiptId,
          label: receipt?.vendor || fileNames.get(pair.receiptId) || "Kuitti",
          reasons: pair.explanation ?? [],
        };
      }),
    });
  }
  for (const [rowId, picks] of salesPlan.ambiguous) {
    const first = picks[0];
    if (!first || !inMonth(first.transaction.date, options.month)) continue;
    ambiguous.push({
      target: "sales_invoice",
      transactionId: rowId,
      row: { date: first.transaction.date, amountCents: first.transaction.amountCents, counterparty: first.transaction.counterparty },
      options: picks.map((pick) => ({
        candidateId: pick.invoice.id,
        label: `Lasku ${pick.invoice.number} · ${pick.invoice.customer.name}`,
        reasons: pick.verdict.reasons,
      })),
    });
  }

  return {
    aiAvailable: Boolean(judge),
    matches,
    ambiguous,
    reviewedNow: outcomes.filter((o) => !o.fromCache && o.status !== "unreviewed").length,
    fromCache: outcomes.filter((o) => o.fromCache).length,
    unreviewed: outcomes.filter((o) => o.status === "unreviewed").length,
  };
}

/**
 * The worker's pass after a sync: every owner with open bank rows, a bounded
 * number of model calls each. Failures are logged and skipped.
 */
export async function runMatchReviewCycle(options: { maxCallsPerUser?: number; deadlineMs?: number } = {}): Promise<{ users: number; reviewed: number }> {
  if (!matchReviewEnabled()) return { users: 0, reviewed: 0 };
  const owners = await prisma.statement.findMany({
    where: { transactions: { some: { matchStatus: { in: ["unmatched", "suggested"] } } } },
    select: { userId: true },
    distinct: ["userId"],
  });
  let reviewed = 0;
  for (const { userId } of owners) {
    try {
      const report = await reviewOpenMatches(userId, {
        maxCalls: options.maxCallsPerUser ?? REVIEW_DEFAULTS.maxCalls,
        deadlineMs: options.deadlineMs ?? REVIEW_DEFAULTS.deadlineMs,
      });
      reviewed += report.reviewedNow;
    } catch (error) {
      console.error("Match review failed for an owner:", error instanceof Error ? error.message : error);
    }
  }
  return { users: owners.length, reviewed };
}

/**
 * The chat's "kohdista" turn: receipt matches that may be offered, best
 * first. Certain pairs always; an uncertain pair only when the review
 * confirmed it, or when no model is configured at all (the gate alone then
 * decides). The model gets a small budget so the turn stays quick; what it
 * cannot answer in time is reported as still under review.
 */
export async function reviewedReceiptMatches(
  userId: string,
  options: ReviewRunOptions = {}
): Promise<{ offered: ReviewedMatch[]; report: MatchReviewReport }> {
  const report = await reviewOpenMatches(userId, { maxCalls: 3, deadlineMs: 12_000, ...options });
  const offered = report.matches
    .filter((m) => m.target === "receipt" && (m.passed || (m.status === "unreviewed" && !report.aiAvailable)))
    .sort((a, b) => Number(b.status === "certain") - Number(a.status === "certain") || b.score - a.score);
  return { offered, report };
}
