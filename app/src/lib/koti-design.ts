/** Stitch's comparisons use the same gross cash/document basis as the headline cards. */
export interface TrendMonth {
  month: string;
  income: number;
  expenses: number;
  source?: "tiliote" | "kuitit";
}

export function moneyTrend(rows: readonly TrendMonth[] | null | undefined, month: string, source: "tiliote" | "kuitit", metric: "income" | "expenses", value: number) {
  const [year, number] = month.split("-").map(Number);
  const previousDate = new Date(Date.UTC(year, number - 2, 1));
  const previousMonth = `${previousDate.getUTCFullYear()}-${String(previousDate.getUTCMonth() + 1).padStart(2, "0")}`;
  const history = (rows ?? []).filter((row) => row.month <= month && row.source === source);
  const previous = history.find((row) => row.month === previousMonth);
  const points = history.map((row) => row.month === month ? value : row[metric]);
  return {
    previousMonth,
    points: points.length > 1 ? points : [],
    percent: previous && previous[metric] > 0 ? Math.round((value - previous[metric]) / previous[metric] * 100 + 1e-8) : null,
  };
}

export function monthIsComplete(facts: { done: number; total: number; blocking: number; otherOpen: boolean; hasErrors: boolean; hasStatement: boolean }) {
  return facts.total > 0 && facts.done === facts.total && facts.blocking === 0 && !facts.otherOpen && !facts.hasErrors && facts.hasStatement;
}
