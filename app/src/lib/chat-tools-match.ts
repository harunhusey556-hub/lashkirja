/**
 * review_matches: the assistant's way to review bank-row matches on demand.
 * It runs the strict gate over the owner's open bank rows (receipts and sales
 * invoices), asks the configured model (with thinking, when it takes it) about
 * the uncertain picks, and returns only what passed, with Finnish reasons.
 * Every passed receipt match (and every ambiguous receipt row) becomes a card
 * of the reply's batch match card, and the passed receipt pairs are returned
 * as a batch the owner can accept in one tap. Nothing is linked until the
 * owner taps Hyväksy.
 */
import { z } from "zod";
import { reviewOpenMatches, type ReviewedMatch } from "./match-review-run";
import { buildMatchBatch } from "./chat-match-batch";
import { eur, isoDay, ToolInputError } from "./chat-tools-shared";
import type { ChatTool } from "./chat-tools-read";

const args = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() }).strict();

/** The chat turn's own budget: a few model calls, answered within seconds. */
export const CHAT_REVIEW_LIMITS = { maxCalls: 4, concurrency: 4, deadlineMs: 12_000 };

/**
 * How many rows of each list the model reads; passedTotal and batch.count stay
 * the real totals. The owner's screen gets every proposal as a card (see
 * chat-match-batch.ts), so this only has to fit the tool-result size cap with
 * hundreds of matches.
 */
const LIST_LIMIT = 20;

function bankRowHref(date: Date | null, transactionId: string): string {
  const params = new URLSearchParams();
  if (date) params.set("month", date.toISOString().slice(0, 7));
  params.set("rivi", transactionId);
  return `/pankki/tapahtumat?${params.toString()}`;
}

function candidateHref(match: Pick<ReviewedMatch, "target" | "candidateId">): string {
  return match.target === "receipt" ? `/kuitit/kuitti?id=${match.candidateId}` : `/laskut/lasku?id=${match.candidateId}`;
}

function bankRow(row: { date: Date | null; amountCents: number; counterparty: string | null }) {
  return { date: isoDay(row.date), amount: eur(row.amountCents), counterparty: row.counterparty };
}

const NOTE = [
  "Only 'passed' matches may be suggested; say why with their Finnish reasons (e.g. 'Miksi: viite täsmää · summa sama').",
  "Quote passedTotal as the number of kuittia that täsmäävät. When truncated is true the list below shows only the first rows; say the rest exist too.",
  "batch.count is how many passed receipt pairs the owner can accept in one tap: say 'hyväksy ne kerralla' and quote it. batch.ambiguous is how many rows stay the owner's choice.",
  "The user sees every passed receipt pair and every ambiguous row as a card list with a one-tap 'Hyväksy kaikki varmat'; say 'Löysin N ehdotusta, M niistä varmoja' (N = batch.count + batch.ambiguous, M = batch.count) and do not point the user to the Pankki view for these. Nothing was linked. A passed sales-invoice match is recorded from the invoice page.",
  "For 'ambiguous' rows say that two candidates fit equally and the user should choose; never pick one yourself.",
  "If nothing passed, say there is no confident suggestion. Do not suggest anything that is not listed here.",
].join(" ");

export const reviewMatches: ChatTool = {
  definition: {
    type: "function",
    function: {
      name: "review_matches",
      description:
        "Reviews which open bank rows belong to which receipt or sales invoice: a strict check (exact amount plus viite, IBAN or the same name; dates only rank) and an AI review with reasoning for uncertain pairs. Returns every match that passed, with Finnish reasons, the total count, and a batch of all passed receipt pairs the user can accept in one action; it also lists rows where two candidates fit equally. All passed receipt matches are shown to the user as a card list to confirm. Use when the user asks to match, reconcile or check bank rows (kohdista, eşleştir).",
      parameters: {
        type: "object",
        properties: {
          month: { type: "string", description: "Only bank rows booked in this month, YYYY-MM. Omit for all open rows." },
        },
      },
    },
  },
  async run(ctx, raw) {
    const parsed = args.safeParse(raw ?? {});
    if (!parsed.success) throw new ToolInputError("Invalid argument month: use YYYY-MM.");
    const month = parsed.data.month;
    const report = await reviewOpenMatches(ctx.userId, { month, ...CHAT_REVIEW_LIMITS });

    // Passed: certain (viite + amount), or confirmed by the review. With no
    // model configured at all the gate alone decides.
    const offerable = (m: ReviewedMatch) => m.passed || (!report.aiAvailable && m.status === "unreviewed");
    const passed = report.matches
      .filter(offerable)
      .sort((a, b) => Number(b.status === "certain") - Number(a.status === "certain") || b.score - a.score);
    const rejected = report.matches.filter((m) => m.status === "ai_rejected");
    const waiting = report.matches.filter((m) => !offerable(m) && m.status === "unreviewed").length;

    // Ambiguous rows are never pairs (a hard gate rule, see match-gate.ts): they
    // stay the owner's choice, listed on the card with their options.
    const receiptPassed = passed.filter((m) => m.target === "receipt");
    const { cards, batch, proposal } = buildMatchBatch(
      receiptPassed,
      report.ambiguous.filter((row) => row.target === "receipt")
    );
    const cardIds = new Set(cards.filter((c) => !c.ambiguous).map((c) => c.transactionId));
    const shown = passed.slice(0, LIST_LIMIT);

    return {
      ok: true,
      month: month ?? null,
      aiReview: report.aiAvailable,
      passed: shown.map((m) => ({
        transactionId: m.transactionId,
        kind: m.target === "receipt" ? "kuitti" : "myyntilasku",
        bankRow: bankRow(m.row),
        match: {
          id: m.candidateId,
          label: m.candidate.label,
          date: isoDay(m.candidate.date),
          amount: m.candidate.amountCents == null ? null : eur(m.candidate.amountCents),
          // A receipt pair's links live on its card; a sales-invoice match has no card.
          ...(m.target === "receipt" ? {} : { href: candidateHref(m) }),
        },
        status: m.status,
        confidence: m.confidence,
        reasons: m.reasons,
        ...(m.target === "receipt" ? { shownAsCard: cardIds.has(m.transactionId) } : { href: bankRowHref(m.row.date, m.transactionId) }),
      })),
      passedTotal: passed.length,
      truncated: passed.length > LIST_LIMIT,
      /** One card per passed receipt pair, then one per ambiguous receipt row (ambiguous: true, with options). */
      cards,
      /** One-tap accept-all for every passed receipt pair; nothing ambiguous here. */
      batch: {
        count: batch.confident,
        ambiguous: batch.ambiguous,
        href: "/api/matching/confirm-all",
        pairs: batch.pairs,
      },
      notSuggested: rejected.slice(0, LIST_LIMIT).map((m) => ({
        transactionId: m.transactionId,
        bankRow: bankRow(m.row),
        candidate: m.candidate.label,
        why: m.reasons,
      })),
      ambiguous: report.ambiguous.slice(0, LIST_LIMIT).map((row) => ({
        transactionId: row.transactionId,
        bankRow: bankRow(row.row),
        options: row.options.map((option) => ({ label: option.label, reasons: option.reasons })),
        href: bankRowHref(row.row.date, row.transactionId),
      })),
      stillReviewing: waiting,
      ...(proposal ? { proposal } : {}),
      note: NOTE,
    };
  },
};

export const MATCH_TOOLS: ChatTool[] = [reviewMatches];
