/** One map from a live status or count to a badge. Screens must not invent colors. */

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger" | "inverse";

export type StatusBadgeModel = {
  tone: BadgeTone;
  label: string;
  count?: number;
};

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: "bg-warm-gray-light/30 text-warm-gray",
  accent: "bg-blush text-accent-dark",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  danger: "bg-danger/10 text-danger",
  inverse: "bg-white/15 text-white",
};

export function badgeClass(tone: BadgeTone): string {
  return `inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-medium ${TONE_CLASS[tone]}`;
}

export function invoiceBadge(status: string): StatusBadgeModel {
  switch (status) {
    case "draft":
      return { tone: "neutral", label: "Luonnos" };
    case "sent":
      return { tone: "accent", label: "Lähetetty" };
    case "overdue":
      return { tone: "danger", label: "Myöhässä" };
    case "paid":
      return { tone: "success", label: "Maksettu" };
    case "credited":
      return { tone: "neutral", label: "Hyvitetty" };
    default:
      return { tone: "neutral", label: status || "Tuntematon" };
  }
}

export function purchaseBadge(status: string): StatusBadgeModel {
  switch (status) {
    case "open":
      return { tone: "accent", label: "Avoin" };
    case "paid":
      return { tone: "success", label: "Maksettu" };
    case "cancelled":
      return { tone: "neutral", label: "Mitätöity" };
    case "overdue":
      return { tone: "danger", label: "Myöhässä" };
    default:
      return { tone: "neutral", label: status || "Tuntematon" };
  }
}

/** Receipt link state. Candidates are suggestions even before a status flip. */
export function receiptMatchBadge(status: string, candidateCount = 0): StatusBadgeModel {
  if (status === "linked" || status === "confirmed") {
    return { tone: "success", label: "Linkitetty" };
  }
  if (status === "suggested" || candidateCount > 0) {
    return { tone: "warning", label: candidateCount > 1 ? "Ehdotuksia" : "Ehdotus" };
  }
  return { tone: "neutral", label: "Ei linkitystä" };
}

/** Bank row. Transfers have no receipt badge. Suggestions are a review, not a success. */
export function bankMatchBadge(type: string, matchStatus: string): StatusBadgeModel | null {
  if (type === "oma_siirto") return null;
  if (type === "palkka") return { tone: "neutral", label: "Palkka" };
  if (matchStatus === "confirmed") return { tone: "success", label: "Linkitetty" };
  if (matchStatus === "suggested") return { tone: "warning", label: "Ehdotus" };
  if (matchStatus === "ignored") return { tone: "neutral", label: "Ei tarvita" };
  return { tone: "neutral", label: "Puuttuu" };
}

/**
 * Home matching chip. "Kaikki ok" only when nothing is unmatched or waiting
 * as a suggestion. A leftover suggestion is not done.
 */
export function matchingSummaryBadge(input: {
  matchable: number;
  matched: number;
  suggested: number;
}): StatusBadgeModel | null {
  if (input.matchable <= 0) return null;
  const missing = Math.max(0, input.matchable - input.matched - input.suggested);
  if (missing > 0) return { tone: "warning", label: "puuttuu", count: missing };
  if (input.suggested > 0) return { tone: "accent", label: "ehdotusta", count: input.suggested };
  return { tone: "success", label: "Kaikki ok" };
}

export function pendingReceiptCopy(count: number): string {
  if (count === 1) return "1 kuitti odottaa tarkistustasi.";
  return `${count} kuittia odottaa tarkistustasi.`;
}

export function countLabel(count: number, one: string, many: string): string {
  const n = Math.max(0, count);
  return `${n} ${n === 1 ? one : many}`;
}
