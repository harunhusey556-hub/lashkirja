/**
 * Pure helpers for the Raportit charts: which months the bar chart shows, the one honest sentence
 * about the year, and the expense categories as a ranked list. No React, so they are unit tested.
 */

import type { RankedItem } from "@/components/ds/charts/geometry";
import { receiptDrillHref } from "@/lib/report-drill";

export interface ChartPeriod {
  month: string | null;
  incomeNet: number;
  expenseNet: number;
  profitNet: number;
}

const NAMES = [
  "Tammikuu", "Helmikuu", "Maaliskuu", "Huhtikuu", "Toukokuu", "Kesäkuu",
  "Heinäkuu", "Elokuu", "Syyskuu", "Lokakuu", "Marraskuu", "Joulukuu",
];
const SHORT = ["Tam", "Hel", "Maa", "Huh", "Tou", "Kes", "Hei", "Elo", "Syy", "Lok", "Mar", "Jou"];

/** "Elokuu" for month number 1 to 12; "" for anything else. */
export function monthName(month: number): string {
  return NAMES[month - 1] ?? "";
}

/** Months with any income or expense. Only these count as "months of data". */
export function activeMonths<T extends ChartPeriod>(months: readonly T[]): T[] {
  return months.filter((m) => m.month && (m.incomeNet !== 0 || m.expenseNet !== 0));
}

/** Fewer than two months of data: a bar chart would only be one lonely cluster. */
export const MIN_CHART_MONTHS = 2;

export interface ChartMonth {
  key: string;
  label: string;
  shortLabel: string;
  title: string;
  income: number;
  expense: number;
  period: ChartPeriod | null;
}

/**
 * The months the bar chart shows. A past year shows all 12. The running year shows the six months
 * ending with the current one; early in the year the window starts at January and runs to June, so
 * the chart always has six columns (the months still to come are simply empty).
 */
export function chartMonths(months: readonly ChartPeriod[], year: number, now: { year: number; month: number }): ChartMonth[] {
  let start = 1;
  let end = 12;
  if (year >= now.year) {
    end = now.month;
    start = Math.max(1, end - 5);
    if (end - start < 5) end = Math.min(12, start + 5);
  }
  const byKey = new Map(months.filter((m) => m.month).map((m) => [m.month as string, m]));
  const items: ChartMonth[] = [];
  for (let month = start; month <= end; month += 1) {
    const key = `${year}-${String(month).padStart(2, "0")}`;
    const period = byKey.get(key) ?? null;
    items.push({
      key,
      label: SHORT[month - 1],
      shortLabel: SHORT[month - 1].charAt(0),
      title: NAMES[month - 1],
      income: period?.incomeNet ?? 0,
      expense: period?.expenseNet ?? 0,
      period,
    });
  }
  return items;
}

/** The month the chart selects first: the latest one in the window that has data, else the last column. */
export function defaultSelectedKey(items: readonly ChartMonth[]): string | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i].income !== 0 || items[i].expense !== 0) return items[i].key;
  }
  return items.length ? items[items.length - 1].key : null;
}

/**
 * One human sentence about the year, only when it is true and says something: at least three
 * months of data, and either the expenses are above the income, or one month clearly had the best
 * result. A tie, a thin year or a best month that is itself a loss gives null.
 */
export function reportSentence(
  months: readonly ChartPeriod[],
  year: number,
  now: { year: number; month: number },
): string | null {
  const active = activeMonths(months);
  if (active.length < 3) return null;
  const running = year === now.year;
  const income = active.reduce((sum, m) => sum + m.incomeNet, 0);
  const expense = active.reduce((sum, m) => sum + m.expenseNet, 0);
  if (expense > income) {
    return running
      ? "Menot ovat tähän asti suuremmat kuin tulot."
      : `Menot olivat vuonna ${year} suuremmat kuin tulot.`;
  }
  const ranked = [...active].sort((a, b) => b.profitNet - a.profitNet);
  const best = ranked[0];
  if (!(best.profitNet > 0) || best.profitNet === ranked[1].profitNet) return null;
  const number = Number((best.month as string).slice(5, 7));
  const name = monthName(number);
  if (!name) return null;
  if (!running) return `${name} oli vuoden vahvin kuukausi.`;
  return number === now.month
    ? `${name} on tähän asti vuoden vahvin kuukausi.`
    : `${name} oli tähän asti vuoden vahvin kuukausi.`;
}

/** Category keys are stored lower-case ("tarvikkeet"); a list title starts with a capital. */
export function sentenceCase(text: string): string {
  return text ? text.charAt(0).toLocaleUpperCase("fi-FI") + text.slice(1) : text;
}

/**
 * Expenses by category as ranked rows. A row opens the receipts of that category and year; the
 * uncategorised row has no list of its own to open, so it is plain text.
 */
export function expenseRankedItems(
  rows: readonly { category: string; net: number }[],
  year: number,
): { items: RankedItem[]; totalCents: number } {
  const items: RankedItem[] = [];
  let totalCents = 0;
  for (const row of rows) {
    const valueCents = Math.round(row.net * 100);
    if (!Number.isFinite(valueCents) || valueCents <= 0) continue;
    totalCents += valueCents;
    items.push({
      key: row.category,
      label: sentenceCase(row.category),
      valueCents,
      href:
        row.category === "Luokittelematon"
          ? undefined
          : receiptDrillHref({ month: String(year), type: "meno", category: row.category }),
    });
  }
  return { items, totalCents };
}
