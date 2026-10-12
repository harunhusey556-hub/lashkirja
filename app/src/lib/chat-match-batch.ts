/**
 * The chat's batch match card: every proposal a match review made, in one
 * reply. The owner migrates hundreds of receipts and must not open each one,
 * so the card lists the pairs, accepts the confident ones in one tap
 * (POST /api/matching/confirm-all with `pairs`) and leaves ambiguous rows (two
 * receipts fit one bank row) to a per-row choice. Pure: no database access.
 */
import { buildMatchProposal, type ChatMatchProposal } from "./chat-match-proposal";
import { isoDay } from "./chat-tools-shared";
import type { AmbiguousRow, ReviewedMatch, ReviewedStatus } from "./match-review-run";

/** How many cards of each kind a reply lists; the real totals stay on the batch. */
export const MATCH_CARD_LIMIT = 50;
/** The most pairs one confirm-all request takes (api/matching/confirm-all). */
export const CONFIRM_ALL_MAX_PAIRS = 500;

export interface MatchCardOption {
  receiptId: string;
  label: string;
  reasons: string[];
}

export interface MatchCard {
  transactionId: string;
  /** Null on an ambiguous row: the owner picks one of `options`. */
  receiptId: string | null;
  bankRow: { date: string | null; amountCents: number; counterparty: string | null; href: string };
  receipt: { label: string; date: string | null; amountCents: number | null; href: string } | null;
  /** Finnish "Miksi" reasons. */
  reasons: string[];
  confidence: number | null;
  status: ReviewedStatus | "ambiguous";
  /** Two or more receipts fit this bank row equally; never part of the batch. */
  ambiguous: boolean;
  options?: MatchCardOption[];
}

export interface ChatMatchBatch {
  type: "match_batch";
  /** Confident cards first, then ambiguous rows. */
  cards: MatchCard[];
  /** Confident pairs the primary button accepts (all of them, not only the listed cards). */
  confident: number;
  ambiguous: number;
  /** Cards or pairs beyond what is listed / accepted per request. */
  truncated: boolean;
  /** Ids only, so a long list stays small; ambiguous rows are never here. */
  pairs: Array<{ transactionId: string; receiptId: string }>;
}

function bankRowHref(date: Date | null, transactionId: string): string {
  const params = new URLSearchParams();
  if (date) params.set("month", date.toISOString().slice(0, 7));
  params.set("rivi", transactionId);
  return `/pankki/tapahtumat?${params.toString()}`;
}

function confidentCard(m: ReviewedMatch): MatchCard {
  return {
    transactionId: m.transactionId,
    receiptId: m.candidateId,
    bankRow: { date: isoDay(m.row.date), amountCents: m.row.amountCents, counterparty: m.row.counterparty, href: bankRowHref(m.row.date, m.transactionId) },
    receipt: {
      label: m.candidate.label,
      date: isoDay(m.candidate.date),
      amountCents: m.candidate.amountCents,
      href: `/kuitit/kuitti?id=${m.candidateId}`,
    },
    reasons: m.reasons,
    confidence: m.confidence,
    status: m.status,
    ambiguous: false,
  };
}

function ambiguousCard(row: AmbiguousRow): MatchCard {
  return {
    transactionId: row.transactionId,
    receiptId: null,
    bankRow: { date: isoDay(row.row.date), amountCents: row.row.amountCents, counterparty: row.row.counterparty, href: bankRowHref(row.row.date, row.transactionId) },
    receipt: null,
    reasons: [],
    confidence: null,
    status: "ambiguous",
    ambiguous: true,
    options: row.options.map((option) => ({ receiptId: option.candidateId, label: option.label, reasons: option.reasons })),
  };
}

/**
 * `confident` are the receipt matches that passed (best first), `ambiguous`
 * the receipt rows left to the owner. The single-card case (exactly one
 * confident match, nothing ambiguous) keeps the plain proposal, so a lone
 * suggestion is decided and remembered as before.
 */
export function buildMatchBatch(confident: ReviewedMatch[], ambiguous: AmbiguousRow[]): {
  cards: MatchCard[];
  batch: ChatMatchBatch;
  /** What the reply stores: the batch card, or a single proposal for one lone pair; null when nothing to offer. */
  proposal: ChatMatchBatch | ChatMatchProposal | null;
} {
  const pairs = confident.slice(0, CONFIRM_ALL_MAX_PAIRS).map((m) => ({ transactionId: m.transactionId, receiptId: m.candidateId }));
  const cards = [...confident.slice(0, MATCH_CARD_LIMIT).map(confidentCard), ...ambiguous.slice(0, MATCH_CARD_LIMIT).map(ambiguousCard)];
  const batch: ChatMatchBatch = {
    type: "match_batch",
    cards,
    confident: pairs.length,
    ambiguous: ambiguous.length,
    truncated: confident.length > MATCH_CARD_LIMIT || ambiguous.length > MATCH_CARD_LIMIT || confident.length > CONFIRM_ALL_MAX_PAIRS,
    pairs,
  };
  let proposal: ChatMatchBatch | ChatMatchProposal | null = null;
  if (confident.length === 1 && ambiguous.length === 0) {
    const m = confident[0];
    proposal = buildMatchProposal(
      { id: m.transactionId, date: m.row.date, counterparty: m.row.counterparty, message: m.row.message, amountCents: m.row.amountCents },
      { id: m.candidateId, vendor: m.candidate.label, totalAmountCents: m.candidate.amountCents, fileName: m.candidate.fileName ?? "" },
      { score: m.confidence ?? m.score, reasons: [], explanation: m.reasons }
    );
  } else if (cards.length > 0) {
    proposal = batch;
  }
  return { cards, batch, proposal };
}

/** The assistant's one-line count for a batch card: "Löysin N ehdotusta, M niistä varmoja." */
export function batchSummaryFi(batch: Pick<ChatMatchBatch, "confident" | "ambiguous">): string {
  const total = batch.confident + batch.ambiguous;
  const lead = `Löysin ${total} ehdotusta, ${batch.confident} niistä varmoja.`;
  const open = batch.confident > 0 ? " Hyväksy ne kerralla alta." : "";
  const choose = batch.ambiguous > 0 ? ` ${batch.ambiguous} riville sopii kaksi yhtä hyvää kuittia: valitse ne itse alta.` : "";
  return `${lead}${open}${choose} En ole vielä yhdistänyt mitään.`;
}

export function batchSummaryEn(batch: Pick<ChatMatchBatch, "confident" | "ambiguous">): string {
  const total = batch.confident + batch.ambiguous;
  const lead = `I found ${total} suggestions, ${batch.confident} of them confident.`;
  const open = batch.confident > 0 ? " Accept them all at once below." : "";
  const choose = batch.ambiguous > 0 ? ` ${batch.ambiguous} row${batch.ambiguous === 1 ? " has" : "s have"} two equally likely receipts: choose those yourself below.` : "";
  return `${lead}${open}${choose} I have not linked anything yet.`;
}
