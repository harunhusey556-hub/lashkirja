import { formatEur } from "@/lib/format";

/**
 * Words the charts say. Kept apart from the components so the sentences that
 * screen readers hear and the line above the bars are unit tested.
 */

const axisFormatter = new Intl.NumberFormat("fi-FI", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 0,
  maximumFractionDigits: 0,
});

/** Value-axis label: whole euros, "1 500 €", "0 €" (fi-FI, non-breaking spaces). */
export function formatAxisEur(value: number): string {
  if (!Number.isFinite(value)) return "";
  return axisFormatter.format(Math.abs(value) < 0.5 ? 0 : value);
}

export type MonthFigures = { label: string; income: number; expense: number };

/** "Syyskuu: tulot 1 200,00 €, menot 340,50 €" (euros, as the reports deliver them). */
export function monthSummary({ label, income, expense }: MonthFigures): string {
  return `${label}: tulot ${formatEur(income)}, menot ${formatEur(expense)}`;
}

/** One sentence for the whole bar chart: how many months and the totals. */
export function barChartSummary(items: readonly { income: number; expense: number }[]): string {
  const income = items.reduce((sum, item) => sum + (Number.isFinite(item.income) ? item.income : 0), 0);
  const expense = items.reduce((sum, item) => sum + (Number.isFinite(item.expense) ? item.expense : 0), 0);
  const months = items.length === 1 ? "1 kuukausi" : `${items.length} kuukautta`;
  return `Tulot ja menot, ${months}. Yhteensä tulot ${formatEur(income)}, menot ${formatEur(expense)}.`;
}

/** The sentence a ranked list says about itself ("Suurin: Tarvikkeet 420,00 €, 62 %."). */
export function rankedSummary(rows: readonly { label: string; valueCents: number }[], totalCents: number): string {
  if (rows.length === 0 || !(totalCents > 0)) return "";
  const top = rows[0];
  const percent = Math.round((top.valueCents / totalCents) * 100);
  const rowWord = rows.length === 1 ? "1 rivi" : `${rows.length} riviä`;
  return `${rowWord}, yhteensä ${formatEur(totalCents / 100)}. Suurin: ${top.label} ${formatEur(top.valueCents / 100)}, ${percent} %.`;
}

/** A neutral sentence for a sparkline when the caller has no better one: "Nousi 120,00 €, nyt 1 000,00 €." */
export function sparklineFallback(points: readonly number[]): string {
  const clean = points.filter((value) => Number.isFinite(value));
  if (clean.length < 2) return "";
  const first = clean[0];
  const last = clean[clean.length - 1];
  if (Math.abs(last - first) < 0.005) return `Ei muutosta, ${formatEur(last)}.`;
  return `${last > first ? "Nousi" : "Laski"} ${formatEur(Math.abs(last - first))}, nyt ${formatEur(last)}.`;
}
