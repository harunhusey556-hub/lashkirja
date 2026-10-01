import { formatEur } from "@/lib/format";

export interface RunPlan {
  plan: Array<{
    recurringInvoiceId: string;
    name: string;
    customerName: string;
    customerEmail: string | null;
    autoSend: boolean;
    /** What each run bills, VAT included, in the same order as issueDates. */
    grossByDate: number[];
    issueDates: string[];
  }>;
}

/** "3 × 100,00 € ja 1 × 99,00 €": equal amounts are grouped, so a rate change mid-catch-up shows both. */
function amountsText(grossByDate: number[]): string {
  const groups: Array<{ gross: number; count: number }> = [];
  for (const gross of grossByDate) {
    const last = groups[groups.length - 1];
    if (last && last.gross === gross) last.count++;
    else groups.push({ gross, count: 1 });
  }
  const single = groups.length === 1 && groups[0].count === 1;
  return groups
    .map((group) => (single ? formatEur(group.gross) : `${group.count} × ${formatEur(group.gross)}`))
    .join(" + ");
}

/** "Uusi vuosilasku 100,00 € ja Kuukausilasku 50,00 €. 1 lähetetään sähköpostilla. Lähetettyä laskua ei voi perua, vain hyvittää." */
export function runPlanSummary(plan: RunPlan["plan"] | null): string {
  if (!plan) return "";
  const sends = plan.filter((entry) => entry.autoSend && entry.customerEmail).length;
  const parts = plan.map((entry) => `${entry.name} ${amountsText(entry.grossByDate)}`);
  const drafts = plan.length - sends;
  const sentence = [
    `${parts.join(", ")}.`,
    sends > 0 ? `${sends === 1 ? "1 lähetetään" : `${sends} lähetetään`} sähköpostilla.` : "",
    drafts > 0 ? `${drafts === 1 ? "1 jää" : `${drafts} jää`} luonnokseksi.` : "",
    sends > 0 ? "Lähetettyä laskua ei voi perua, vain hyvittää." : "",
  ];
  return sentence.filter(Boolean).join(" ");
}
