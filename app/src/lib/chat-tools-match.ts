/**
 * review_matches: the assistant's way to review bank-row matches on demand.
 * It runs the strict gate over the owner's open bank rows (receipts and sales
 * invoices), asks the configured model (with thinking, when it takes it) about
 * the uncertain picks, and returns only what passed, with Finnish reasons.
 * The best passed receipt match becomes the reply's match card; nothing is
 * linked until the owner taps Hyväksy.
 */
import { z } from "zod";
import { reviewOpenMatches, type ReviewedMatch } from "./match-review-run";
import { buildMatchProposal } from "./chat-match-proposal";
import { eur, isoDay, ToolInputError } from "./chat-tools-shared";
import type { ChatTool } from "./chat-tools-read";

const args = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() }).strict();

/** The chat turn's own budget: a few model calls, answered within seconds. */
export const CHAT_REVIEW_LIMITS = { maxCalls: 4, concurrency: 4, deadlineMs: 12_000 };

const LIST_LIMIT = 10;

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
  "The receipt card (if any) waits for the user's Hyväksy; nothing was linked. A passed sales-invoice match is recorded from the invoice page.",
  "For 'ambiguous' rows say that two candidates fit equally and the user should choose; never pick one yourself.",
  "If nothing passed, say there is no confident suggestion. Do not suggest anything that is not listed here.",
].join(" ");

export const reviewMatches: ChatTool = {
  definition: {
    type: "function",
    function: {
      name: "review_matches",
      description:
        "Reviews which open bank rows belong to which receipt or sales invoice: a strict check (exact amount plus viite, IBAN or the same name; dates only rank) and an AI review with reasoning for uncertain pairs. Returns only matches that passed, with Finnish reasons, and lists rows where two candidates fit equally. The best passed receipt match is shown to the user as a card to confirm. Use when the user asks to match, reconcile or check bank rows (kohdista, eşleştir).",
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

    const card = passed.find((m) => m.target === "receipt");
    const proposal = card
      ? buildMatchProposal(
          { id: card.transactionId, date: card.row.date, counterparty: card.row.counterparty, message: card.row.message, amountCents: card.row.amountCents },
          { id: card.candidateId, vendor: card.candidate.label, totalAmountCents: card.candidate.amountCents, fileName: card.candidate.fileName ?? "" },
          { score: card.confidence ?? card.score, reasons: [], explanation: card.reasons }
        )
      : null;

    return {
      ok: true,
      month: month ?? null,
      aiReview: report.aiAvailable,
      passed: passed.slice(0, LIST_LIMIT).map((m) => ({
        transactionId: m.transactionId,
        kind: m.target === "receipt" ? "kuitti" : "myyntilasku",
        bankRow: bankRow(m.row),
        match: {
          id: m.candidateId,
          label: m.candidate.label,
          date: isoDay(m.candidate.date),
          amount: m.candidate.amountCents == null ? null : eur(m.candidate.amountCents),
          href: candidateHref(m),
        },
        status: m.status,
        confidence: m.confidence,
        reasons: m.reasons,
        shownAsCard: card === m,
        href: bankRowHref(m.row.date, m.transactionId),
      })),
      passedTotal: passed.length,
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
