"use client";

import { Section } from "@/components/ds";
import { BarChart, BarChartSkeleton, type BarChartItem } from "@/components/ds/charts";
import { monthShort, monthTitle } from "./trend";

/**
 * Koti's "Tulot ja menot" over the last six months (OWN-22), on the shared
 * BarChart (income in success green, expenses in quiet ink, 2 px rounded ends,
 * the figures of the selected month printed above as text).
 *
 * The months follow Koti's own rule (lib/koti-cashflow.ts): a month with a
 * tiliote is the bank's, any other month the documents', so the highlighted
 * bar always equals the Tulot and Menot cards above it. Tapping a bar (or
 * dragging across them) opens that month on Koti: the drill-down is the month
 * view itself, whose cards lead on to the rows.
 */

export interface CashflowRow {
  month: string;
  income: number;
  expenses: number;
}

export function cashflowItems(rows: readonly CashflowRow[]): BarChartItem[] {
  return rows.map((row) => ({
    key: row.month,
    label: monthShort(row.month),
    shortLabel: monthShort(row.month).charAt(0),
    title: monthTitle(row.month),
    income: row.income,
    expense: row.expenses,
  }));
}

export function CashflowCard({
  rows,
  shownMonth,
  onSelectMonth,
}: {
  /** undefined: not known yet (a cache from before the chart), drawn as a skeleton at the final size. */
  rows: readonly CashflowRow[] | null | undefined;
  shownMonth: string;
  onSelectMonth: (month: string) => void;
}) {
  if (rows === undefined) {
    return (
      <Section title="Tulot ja menot, 6 kk">
        <div className="p-4">
          <BarChartSkeleton />
        </div>
      </Section>
    );
  }
  const items = rows ? cashflowItems(rows) : [];
  // No movement in six months: no chart (the month cards above already say 0 €).
  if (!items.some((item) => item.income !== 0 || item.expense !== 0)) return null;
  return (
    <Section title="Tulot ja menot, 6 kk">
      <div className="p-4">
        <BarChart
          items={items}
          selectedKey={items.some((item) => item.key === shownMonth) ? shownMonth : null}
          onSelect={(key) => {
            if (key !== shownMonth) onSelectMonth(key);
          }}
          animateKey="koti-cashflow"
        />
      </div>
    </Section>
  );
}
