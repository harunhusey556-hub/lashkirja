import { centsToEuros } from "./money";

export interface ChatMatchProposal {
  type: "match_proposal";
  transactionId: string;
  receiptId: string;
  txSummary: string;
  receiptSummary: string;
  confidenceScore: number;
  /** Finnish "Miksi" reasons shown on the card ("viite täsmää", "summa sama"). */
  reasons: string[];
}

const CODE_LABELS: Record<string, string> = {
  viite: "viite täsmää",
  amount: "summa sama",
  iban: "tilinumero sama",
  vendor: "nimi vastaa",
};

/**
 * One bank row and one receipt as the chat offers them: the summaries the
 * proposal card shows. Shared by the "kohdista" chat turn, a receipt sent to
 * the chat (chat-receipt.ts) and the review_matches tool, so all read alike.
 */
export function buildMatchProposal(
  tx: { id: string; date: Date | null; counterparty: string | null; message: string | null; amountCents: number },
  receipt: { id: string; vendor: string | null; totalAmountCents: number | null; fileName: string },
  candidate: { score: number; reasons: string[]; explanation?: string[] }
): ChatMatchProposal {
  const txDateStr = tx.date ? new Date(tx.date).toLocaleDateString("fi-FI") : "";
  const txVendor = tx.counterparty || tx.message || "Tuntematon siirto";
  const txAmt = centsToEuros(tx.amountCents).toFixed(2);
  const rVendor = receipt.vendor || receipt.fileName;
  const rAmt = receipt.totalAmountCents ? centsToEuros(receipt.totalAmountCents).toFixed(2) : "?";
  // The card shows these as they are: Finnish reasons, never a code.
  const reasons = candidate.explanation?.length
    ? candidate.explanation
    : candidate.reasons.map((code) => CODE_LABELS[code]).filter((label): label is string => Boolean(label));
  return {
    type: "match_proposal",
    transactionId: tx.id,
    receiptId: receipt.id,
    txSummary: `${txVendor} — ${txAmt} € (${txDateStr})`,
    receiptSummary: `${rVendor} — ${rAmt} € (${receipt.fileName})`,
    confidenceScore: candidate.score,
    reasons,
  };
}
