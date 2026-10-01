import type { InvoiceDisplayStatus } from "./invoices";

/** One place for status wording and colour. Words match what the app already shows. */
export type Tone = "neutral" | "accent" | "danger" | "success" | "warning";
type Label = { label: string; tone: Tone };

export const SALES_STATUS: Record<InvoiceDisplayStatus, Label> = {
  draft: { label: "Luonnos", tone: "neutral" },
  sent: { label: "Odottaa maksua", tone: "neutral" },
  overdue: { label: "Myöhässä", tone: "danger" },
  paid: { label: "Maksettu", tone: "success" },
  credited: { label: "Hyvitetty", tone: "neutral" },
};

export const PURCHASE_STATUS: Record<"open" | "overdue" | "paid" | "cancelled", Label> = {
  open: { label: "Odottaa maksua", tone: "neutral" },
  overdue: { label: "Myöhässä", tone: "danger" },
  paid: { label: "Maksettu", tone: "success" },
  cancelled: { label: "Mitätöity", tone: "neutral" },
};

/** A receipt's bank-match state, for the kuitit list's `StatusTag`. */
export type ReceiptMatchStatusKey = "linked" | "suggested" | "candidates" | "unlinked";
export const RECEIPT_MATCH_STATUS: Record<ReceiptMatchStatusKey, Label> = {
  linked: { label: "Kohdistettu", tone: "success" },
  suggested: { label: "Ehdotus", tone: "warning" },
  candidates: { label: "Ehdotus", tone: "warning" },
  unlinked: { label: "Ei kohdistettu", tone: "neutral" },
};

/**
 * Which key of `RECEIPT_MATCH_STATUS` a receipt's match data resolves to -
 * "suggested" only applies once a single best candidate has been picked out,
 * "candidates" is shown when there are several unranked candidates instead,
 * matching the words the kuitit list already showed before this moved into
 * a shared `StatusTag`.
 */
export function receiptMatchStatusKey(match: {
  status: string;
  matchCandidates?: unknown[] | null;
}): ReceiptMatchStatusKey {
  if (match.status === "linked") return "linked";
  if (match.status === "suggested") return "suggested";
  if (match.matchCandidates && match.matchCandidates.length > 0) return "candidates";
  return "unlinked";
}

/** A bank statement transaction's document-state, for the tiliote detail's `StatusTag`. */
export type StatementTxStatusKey = "linked" | "suggested" | "ignored" | "palkka" | "missing";
export const STATEMENT_TX_STATUS: Record<StatementTxStatusKey, Label> = {
  linked: { label: "Kohdistettu", tone: "success" },
  suggested: { label: "Ehdotus", tone: "warning" },
  ignored: { label: "Ei kuittia tarvita", tone: "neutral" },
  palkka: { label: "Palkka", tone: "neutral" },
  missing: { label: "Kuitti puuttuu", tone: "danger" },
};

/**
 * Which key of `STATEMENT_TX_STATUS` a transaction resolves to - `null` for an
 * "oma_siirto" (own transfer), which shows no tag at all, matching the words
 * the tiliote detail already showed before this moved into a shared `StatusTag`.
 */
export function statementTxStatusKey(t: {
  type: string;
  matchStatus: string;
}): StatementTxStatusKey | null {
  if (t.type === "palkka") return "palkka";
  if (t.type === "oma_siirto") return null;
  if (t.matchStatus === "confirmed") return "linked";
  if (t.matchStatus === "suggested") return "suggested";
  if (t.matchStatus === "ignored") return "ignored";
  return "missing";
}
