"use client";

import Link from "next/link";
import { useId, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { TrendingDown, TrendingUp, Minus } from "lucide-react";
import { formatEur } from "@/lib/format";
import { useChartSize, useGrowOnce } from "@/components/ds/charts/hooks";
import { Skeleton } from "@/components/ds";
import {
  balanceChange,
  balanceTrendSummary,
  lineGeometry,
  monthShort,
  monthTitle,
  nearestIndex,
} from "./trend";
import styles from "./charts.module.css";

/**
 * Koti's bank balance card (OWN-22): the total balance as the hero figure, the
 * change over the months drawn, and a 2 px line of the monthly closings.
 *
 * - The whole card is one link to Pankkitilit (the drill-down).
 * - Drag a finger (or hover a mouse) across the line to read a month: the hero
 *   figure and its caption follow the finger, like Stocks; letting go returns
 *   to today. A drag never opens the link.
 * - Fixed heights everywhere, so nothing moves when the data arrives; the line
 *   rises from the baseline once per session (chart-grow-y), and not at all
 *   under reduced motion.
 *
 * With fewer than two months of figures the card keeps its size and says when
 * the line will appear, instead of drawing a lone dot.
 */

function formatSigned(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  if (rounded === 0) return "±0 €";
  return `${rounded > 0 ? "+" : "−"}${formatEur(Math.abs(rounded))}`;
}

export const BALANCE_PLOT_HEIGHT = 96;
export const BALANCE_LABEL_HEIGHT = 22;
const INSET = 6;

export interface BalanceTrendPoint {
  month: string;
  balance: number;
}

export function BalanceTrendCard({
  total,
  accountCount,
  points,
  href = "/kirjanpito/pankkitilit",
  animateKey,
}: {
  total: number;
  accountCount: number;
  /** null: too few months to draw; undefined: not known yet (a cache from before the chart). */
  points: readonly BalanceTrendPoint[] | null | undefined;
  href?: string;
  animateKey?: string;
}) {
  const animate = useGrowOnce(animateKey);
  const plotRef = useRef<HTMLDivElement>(null);
  const { width } = useChartSize(plotRef);
  const [active, setActive] = useState<number | null>(null);
  const drag = useRef<{ id: number; x: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const gradientId = useId().replace(/:/g, "");

  const series = points && points.length >= 2 ? points : null;
  const geometry = series && width > 0 ? lineGeometry(series.map((p) => p.balance), width, BALANCE_PLOT_HEIGHT, INSET) : null;
  const change = series ? balanceChange(series) : null;
  const picked = series && active !== null ? series[active] : null;
  const caption = picked
    ? `${monthTitle(picked.month)}n lopussa`
    : `Pankkitilien saldo · ${accountCount} ${accountCount === 1 ? "tili" : "tiliä"}`;
  const hero = picked ? picked.balance : total;
  const ChangeIcon = !change || change.amount === 0 ? Minus : change.amount > 0 ? TrendingUp : TrendingDown;

  const pick = (clientX: number) => {
    const box = plotRef.current?.getBoundingClientRect();
    if (!box || !series) return;
    setActive(nearestIndex(clientX - box.left, box.width, series.length, INSET));
  };
  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.pointerType === "mouse") return;
    drag.current = { id: event.pointerId, x: event.clientX, moved: false };
  };
  const onPointerMove = (event: ReactPointerEvent) => {
    if (event.pointerType === "mouse") {
      pick(event.clientX);
      return;
    }
    const state = drag.current;
    if (!state || state.id !== event.pointerId) return;
    if (!state.moved && Math.abs(event.clientX - state.x) > 8) state.moved = true;
    if (state.moved) pick(event.clientX);
  };
  const endDrag = (event: ReactPointerEvent) => {
    const state = drag.current;
    drag.current = null;
    if (state && state.id === event.pointerId && state.moved) suppressClick.current = true;
    setActive(null);
  };
  const onClick = (event: MouseEvent) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      event.preventDefault();
    }
  };

  const activePoint = geometry && active !== null ? geometry.points[active] : null;
  const lastPoint = geometry ? geometry.points[geometry.points.length - 1] : null;

  return (
    <Link
      href={href}
      onClick={onClick}
      aria-label={`${series ? balanceTrendSummary(series) : `Pankkitilien saldo ${formatEur(total)}.`} Avaa pankkitilit.`}
      className="active-press block rounded-card border border-line bg-surface p-4"
    >
      <p aria-hidden className="text-caption text-ink-2">{caption}</p>
      <p aria-hidden className="mt-0.5 text-title-2 font-bold tracking-[-0.02em] tabular-nums text-ink">
        {formatEur(hero)}
      </p>
      <p aria-hidden className="mt-0.5 flex min-h-5 items-center gap-1 text-caption tabular-nums text-ink-2">
        {change && !picked ? (
          <>
            <ChangeIcon
              size={14}
              strokeWidth={2}
              className={change.amount > 0 ? "text-success" : "text-ink-2"}
            />
            {change.text}
          </>
        ) : picked && active !== null && active > 0 && series ? (
          `${formatSigned(picked.balance - series[active - 1].balance)} edellisestä kuusta`
        ) : null}
      </p>

      <div aria-hidden className="relative mt-3" style={{ height: BALANCE_PLOT_HEIGHT + BALANCE_LABEL_HEIGHT }}>
        {series ? (
          <>
            <div
              ref={plotRef}
              className={`relative touch-pan-y ${styles.plot}`}
              style={{ height: BALANCE_PLOT_HEIGHT }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              onPointerLeave={(event) => {
                if (event.pointerType === "mouse") setActive(null);
              }}
            >
              {geometry ? (
                <svg
                  width={width}
                  height={BALANCE_PLOT_HEIGHT}
                  viewBox={`0 0 ${width} ${BALANCE_PLOT_HEIGHT}`}
                  className={`absolute inset-0 overflow-visible text-accent ${animate ? "chart-grow-y origin-bottom" : ""}`}
                >
                  <defs>
                    <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="currentColor" stopOpacity={0.22} />
                      <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  {/* Baseline: one recessive rule under the plot. */}
                  <line x1={0} x2={width} y1={BALANCE_PLOT_HEIGHT - 0.5} y2={BALANCE_PLOT_HEIGHT - 0.5} className="stroke-line" strokeWidth={1} />
                  <path d={geometry.area} fill={`url(#${gradientId})`} />
                  <path d={geometry.line} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                  {activePoint ? (
                    <line
                      x1={activePoint.x}
                      x2={activePoint.x}
                      y1={0}
                      y2={BALANCE_PLOT_HEIGHT}
                      className="stroke-ink-2"
                      strokeWidth={1}
                      strokeDasharray="2 3"
                    />
                  ) : null}
                  {/* The point being read (or today's): an 8 px dot with a 2 px surface ring. */}
                  {(activePoint ?? lastPoint) ? (
                    <circle
                      cx={(activePoint ?? lastPoint)!.x}
                      cy={(activePoint ?? lastPoint)!.y}
                      r={5}
                      fill="currentColor"
                      className="stroke-surface"
                      strokeWidth={2}
                    />
                  ) : null}
                </svg>
              ) : null}
            </div>
            <div className="relative text-micro text-ink-2" style={{ height: BALANCE_LABEL_HEIGHT }}>
              {geometry
                ? series.map((point, index) => (
                    <span
                      key={point.month}
                      className={`absolute top-1.5 whitespace-nowrap ${index === active ? "font-semibold text-ink" : ""}`}
                      style={{
                        left: geometry.points[index].x,
                        transform:
                          index === 0 ? `translateX(-${INSET}px)` : index === series.length - 1 ? `translateX(calc(-100% + ${INSET}px))` : "translateX(-50%)",
                      }}
                    >
                      {monthShort(point.month)}
                    </span>
                  ))
                : null}
            </div>
          </>
        ) : points === undefined ? (
          <Skeleton tone="soft" className="w-full" height={BALANCE_PLOT_HEIGHT + BALANCE_LABEL_HEIGHT} />
        ) : (
          <div className="flex h-full flex-col justify-end">
            <div className="border-t border-dashed border-line" />
            <p className="pt-2 text-caption text-ink-2" style={{ height: BALANCE_LABEL_HEIGHT + 8 }}>
              Saldon kehitys näkyy, kun tapahtumia on kahdelta kuukaudelta.
            </p>
          </div>
        )}
      </div>
    </Link>
  );
}

/** The card at its final size while Koti's figures load (QUALITY-BAR L1, L9). */
export function BalanceTrendCardSkeleton() {
  return (
    <div aria-hidden className="rounded-card border border-line bg-surface p-4">
      <Skeleton tone="soft" className="mt-0.5 h-3 w-36" />
      <Skeleton className="mt-2 h-7 w-40" />
      <Skeleton tone="soft" className="mt-2 h-3 w-28" />
      <Skeleton tone="soft" className="mt-4 w-full" height={BALANCE_PLOT_HEIGHT + BALANCE_LABEL_HEIGHT - 4} />
    </div>
  );
}
