"use client";

import Link from "next/link";
import { Sparkline } from "@/components/ds/charts";
import { formatEur } from "@/lib/format";
import { MONTHS } from "@/lib/finnish-months";
import { kotiResultLabel } from "@/lib/koti-month";
import { moneyTrend, type TrendMonth } from "@/lib/koti-design";

export function KotiMoneyCards({ month, income, expenses, source, rows, incomeHref, expensesHref, vatRegistered }: {
  month: string; income: number; expenses: number; source: "tiliote" | "kuitit";
  rows?: readonly TrendMonth[] | null; incomeHref: string; expensesHref: string; vatRegistered: boolean;
}) {
  return <div className="stitch-money-grid">
    {([{ metric: "income", title: `Myynti ${MONTHS[Number(month.slice(5)) - 1].toLowerCase()}`, value: income, href: incomeHref, tone: "success", label: "Tulot" },
      { metric: "expenses", title: "Kulut", value: expenses, href: expensesHref, tone: "accent", label: "Menot" }] as const).map((card) => {
      const trend = moneyTrend(rows, month, source, card.metric, card.value);
      return <Link key={card.metric} href={card.href} className="stitch-card stitch-money-card active-press" aria-label={kotiResultLabel(card.label, formatEur(card.value), vatRegistered)}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-caption font-medium text-ink-2">{card.title}</p>
          {trend.points.length > 1 ? <div className="w-9 shrink-0"><Sparkline points={trend.points} ariaLabel={`${card.label}, viimeiset ${trend.points.length} kuukautta`} tone={card.tone} height={18} /></div> : null}
        </div>
        <p className="money mt-3">{formatEur(card.value).replace(/\s*€$/, "")} <small>€</small></p>
        {trend.percent !== null ? <p className={`mt-1 text-caption ${card.metric === "income" ? "text-success" : "text-ink-2"}`}>{trend.percent > 0 ? "+" : ""}{trend.percent} % vs. {MONTHS[Number(trend.previousMonth.slice(5)) - 1].toLowerCase()}</p> : null}
      </Link>;
    })}
  </div>;
}
