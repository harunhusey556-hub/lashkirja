import type { InvoiceDisplayStatus } from "./invoices";

/** One place for status wording and colour. Words match what the app already shows. */
export type Tone = "neutral" | "accent" | "danger" | "success" | "warning";
type Label = { label: string; tone: Tone };

export const SALES_STATUS: Record<InvoiceDisplayStatus, Label> = {
  draft: { label: "Luonnos", tone: "neutral" },
  sent: { label: "Lähetetty", tone: "accent" },
  overdue: { label: "Myöhässä", tone: "danger" },
  paid: { label: "Maksettu", tone: "success" },
  credited: { label: "Hyvitetty", tone: "neutral" },
};

export const PURCHASE_STATUS: Record<"open" | "overdue" | "paid" | "cancelled", Label> = {
  open: { label: "Avoin", tone: "accent" },
  overdue: { label: "Myöhässä", tone: "danger" },
  paid: { label: "Maksettu", tone: "success" },
  cancelled: { label: "Mitätöity", tone: "neutral" },
};

/** A receipt's bank-match state, for the kuitit list's `StatusTag`. */
export type ReceiptMatchStatusKey = "linked" | "suggested" | "candidates" | "unlinked";
export const RECEIPT_MATCH_STATUS: Record<ReceiptMatchStatusKey, Label> = {
  linked: { label: "Linkitetty", tone: "success" },
  suggested: { label: "Ehdotus", tone: "warning" },
  candidates: { label: "Ehdotuksia", tone: "warning" },
  unlinked: { label: "Ei linkitystä", tone: "neutral" },
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
