"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { formatEur } from "@/lib/format";
import { Icon } from "../Icon";
import { groupTopN, relativeFractions, shareLabel, type RankedItem } from "./geometry";
import { useGrowOnce } from "./hooks";
import { rankedSummary } from "./text";

/**
 * A ranked list: each row prints label, amount and share of the total, with a slim horizontal bar
 * under the text (the bar never runs behind the figures, so nothing is ever hard to read).
 * Meant to sit INSIDE a ds Section (it brings no card of its own, only the rows).
 *
 * Props
 * - items: { key, label, valueCents, href? }. Order does not matter, the list sorts descending.
 *   Zero and negative values are left out. With an href the whole row links there.
 * - totalCents: the figure the shares are measured against (usually the sum of all items,
 *   but the caller may pass a bigger total so the rows do not add up to 100 %).
 * - topN (default 5): more rows than topN + 1 collapse into the first topN plus one "Muut" row.
 * - tone: the colour of the bars. "neutral" for expenses, "success" for income, "accent" for a selection.
 * - emptyText: the one calm sentence shown instead of a list when there is nothing to rank.
 * - animateKey: with a key the bars grow in only the first time this session.
 *
 * Bar lengths are relative to the largest row, so rows compare with each other at a glance;
 * the printed share is the honest figure. Use it for expenses by category, income by category,
 * top customers. For a handful of parts of one whole use StackedBar.
 */

const TONE = {
  neutral: "bg-ink-2/60",
  success: "bg-success",
  accent: "bg-accent",
} as const;

export function HBarList({ items, totalCents, topN = 5, tone = "neutral", emptyText, animateKey, ariaLabel }: {
  items: readonly RankedItem[];
  totalCents: number;
  topN?: number;
  tone?: keyof typeof TONE;
  emptyText?: string;
  animateKey?: string;
  ariaLabel?: string;
}) {
  const animate = useGrowOnce(animateKey);
  const rows = groupTopN(items, topN);
  if (rows.length === 0 || !(totalCents > 0)) {
    return emptyText ? <p className="px-4 py-4 text-body text-ink-2">{emptyText}</p> : null;
  }
  const anyLinked = rows.some((row) => row.href && !row.isOther);
  const fractions = relativeFractions(rows.map((row) => row.valueCents));
  return (
    <div role="list" aria-label={ariaLabel ?? rankedSummary(rows, totalCents)} className="divide-y divide-line">
      {rows.map((row, index) => {
        const share = shareLabel(row.valueCents, totalCents);
        const amount = formatEur(row.valueCents / 100);
        const linked = Boolean(row.href) && !row.isOther;
        return (
          <div key={row.key} role="listitem" data-testid="hbar-row" className="relative flex min-h-14 items-center gap-3 px-4 py-3">
            {linked ? (
              <Link href={row.href ?? "#"} aria-label={[row.label, amount, share].filter(Boolean).join(", ")} className="row-link active-press absolute inset-0" />
            ) : null}
            <div className="pointer-events-none relative min-w-0 flex-1">
              <div aria-hidden={linked || undefined} className="flex items-baseline gap-3">
                <span className="min-w-0 flex-1 text-body font-medium text-ink [overflow-wrap:anywhere]">{row.label}</span>
                <span className="shrink-0 text-body tabular-nums text-ink">{amount}</span>
                <span className="w-11 shrink-0 text-right text-caption tabular-nums text-ink-2">{share}</span>
              </div>
              <div aria-hidden className="mt-2 h-1.5 overflow-hidden rounded-full bg-line/60">
                <div
                  className={`h-full origin-left rounded-full ${TONE[tone]} ${animate ? "chart-grow-x" : ""}`}
                  style={{ width: `${fractions[index] * 100}%`, minWidth: 6 }}
                />
              </div>
            </div>
            {linked ? (
              <span aria-hidden className="pointer-events-none relative -mr-1 flex text-ink-2/80">
                <Icon icon={ChevronRight} size="inline" />
              </span>
            ) : anyLinked ? (
              // keeps the figure columns in line when only some rows are links
              <span aria-hidden className="pointer-events-none -mr-1 w-4 shrink-0" />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
