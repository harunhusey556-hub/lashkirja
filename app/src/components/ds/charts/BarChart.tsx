"use client";

import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import { formatEur } from "@/lib/format";
import { barMetrics, barRect, columnIndexAt, labelMode, niceScale, shortLabel, valueFraction } from "./geometry";
import { useChartSize, useGrowOnce } from "./hooks";
import { barChartSummary, formatAxisEur, monthSummary } from "./text";

/**
 * Grouped bars per month: income (success) and expenses (neutral ink-2).
 *
 * Props
 * - items: 6 to 12 of { key, label, shortLabel?, title?, income, expense }. Amounts are euros,
 *   as the reports deliver them. `label` is the axis text ("Syys"); `shortLabel` the text used
 *   when the columns are narrow (default: the first letter); `title` the name in the sentence
 *   above the chart ("Syyskuu"; defaults to label). A negative amount hangs below the baseline.
 * - selectedKey, onSelect: tap a column, or drag a finger across the plot, to select that
 *   month; the selected column gets an accent outline and the figures are printed above the
 *   chart as text ("Syyskuu: tulot X, menot Y"). Without onSelect the chart is a read-only
 *   image with its data in a visually hidden table.
 * - emptyText: the one calm sentence shown instead of a chart when every amount is zero.
 * - animateKey: with a key the bars grow in only the first time this session.
 *
 * The value axis has at most 3 quiet gridlines labelled in whole euros. Labels shrink to one
 * letter when the columns get narrow. Every column is a real button for keyboard and screen
 * readers; on a phone the whole plot is the touch target (the nearest column wins), which is
 * how 12 months stay usable at 320 px.
 *
 * Use it for "how did the months go" on Koti and Raportit. For one category list use HBarList.
 */

export type BarChartItem = { key: string; label: string; shortLabel?: string; title?: string; income: number; expense: number };

export const BAR_PLOT_HEIGHT = 144; // px, the plot without its labels
export const BAR_LABEL_HEIGHT = 28; // px, the month labels under the plot
const AXIS_GUTTER = "calc(2.75rem * var(--text-scale, 1))";

export function BarChart({ items, selectedKey, onSelect, emptyText, animateKey, ariaLabel, className = "" }: {
  items: readonly BarChartItem[];
  selectedKey?: string | null;
  onSelect?: (key: string) => void;
  emptyText?: string;
  animateKey?: string;
  /** Overrides the generated one-sentence summary. */
  ariaLabel?: string;
  className?: string;
}) {
  const animate = useGrowOnce(animateKey);
  const plotRef = useRef<HTMLDivElement>(null);
  const labelRef = useRef<HTMLDivElement>(null);
  const { width, fontPx } = useChartSize(plotRef, labelRef);
  const drag = useRef<{ id: number; x: number; moved: boolean } | null>(null);

  const values = items.flatMap((item) => [item.income, item.expense]);
  const hasData = values.some((value) => Number.isFinite(value) && value !== 0);
  if (items.length === 0 || !hasData) {
    return emptyText ? <p className={`text-body text-ink-2 ${className}`}>{emptyText}</p> : null;
  }

  const scale = niceScale(values);
  const plotWidth = width > 0 ? width : 240;
  const metrics = barMetrics(plotWidth, items.length);
  const mode = labelMode(metrics.columnWidth, Math.max(...items.map((item) => Array.from(item.label).length)), fontPx);
  const zero = valueFraction(0, scale.min, scale.max);
  const selected = items.find((item) => item.key === selectedKey) ?? null;
  const interactive = Boolean(onSelect);
  const summary = ariaLabel ?? barChartSummary(items);

  const pick = (clientX: number) => {
    const box = plotRef.current?.getBoundingClientRect();
    if (!box || !onSelect) return;
    const index = columnIndexAt(clientX - box.left, box.width, items.length);
    if (index >= 0) onSelect(items[index].key);
  };
  const onPointerDown = (event: ReactPointerEvent) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    drag.current = { id: event.pointerId, x: event.clientX, moved: false };
  };
  const onPointerMove = (event: ReactPointerEvent) => {
    const state = drag.current;
    if (!state || state.id !== event.pointerId) return;
    if (!state.moved && Math.abs(event.clientX - state.x) > 6) state.moved = true;
    if (state.moved) pick(event.clientX);
  };
  const onPointerUp = (event: ReactPointerEvent) => {
    const state = drag.current;
    drag.current = null;
    if (state && state.id === event.pointerId && !state.moved) pick(event.clientX);
  };

  const wrapperProps = interactive
    ? ({ role: "group", "aria-label": summary } as const)
    : ({ role: "img", "aria-label": summary } as const);

  return (
    <div {...wrapperProps} className={className}>
      <p aria-live="polite" className="min-h-12 pb-2 text-caption text-ink-2">
        {selected ? (
          <>
            <span className="font-semibold text-ink">{selected.title ?? selected.label}</span>
            {": "}
            <span aria-hidden className="mr-1 inline-block h-2 w-2 rounded-full bg-success align-baseline" />
            tulot <span className="font-semibold tabular-nums text-ink">{formatEur(selected.income)}</span>
            {", "}
            <span aria-hidden className="mr-1 inline-block h-2 w-2 rounded-full bg-ink-2/70 align-baseline" />
            menot <span className="font-semibold tabular-nums text-ink">{formatEur(selected.expense)}</span>
          </>
        ) : interactive ? (
          "Valitse kuukausi palkeista."
        ) : null}
      </p>

      <div className="relative" style={{ height: BAR_PLOT_HEIGHT + BAR_LABEL_HEIGHT }}>
        <div aria-hidden className="absolute inset-y-0 left-0" style={{ right: AXIS_GUTTER }}>
          <div ref={plotRef} className="relative" style={{ height: BAR_PLOT_HEIGHT }}>
            {scale.ticks.map((tick) => (
              <div key={tick} className="absolute inset-x-0 border-t border-line" style={{ bottom: `${valueFraction(tick, scale.min, scale.max) * 100}%` }}>
                <span className="absolute left-full top-0 -translate-y-1/2 whitespace-nowrap pl-1.5 text-micro tabular-nums text-ink-2">{formatAxisEur(tick)}</span>
              </div>
            ))}
            <div className="absolute inset-x-0 border-t border-ink-2/30" style={{ bottom: `${zero * 100}%` }}>
              <span className="absolute left-full top-0 -translate-y-1/2 whitespace-nowrap pl-1.5 text-micro tabular-nums text-ink-2">{formatAxisEur(0)}</span>
            </div>
            <div className="absolute inset-0 flex">
              {items.map((item) => (
                <div key={item.key} className="relative h-full min-w-0 flex-1">
                  {item.key === selected?.key ? (
                    <div
                      className="absolute inset-x-0.5 rounded-[10px] bg-accent/10"
                      style={{ top: -2, height: BAR_PLOT_HEIGHT + BAR_LABEL_HEIGHT - 2 }}
                    />
                  ) : null}
                  <Bar value={item.income} scale={scale} left={`calc(50% - ${metrics.gap / 2 + metrics.barWidth}px)`} width={metrics.barWidth} tone="bg-success" animate={animate} />
                  <Bar value={item.expense} scale={scale} left={`calc(50% + ${metrics.gap / 2}px)`} width={metrics.barWidth} tone="bg-ink-2/70" animate={animate} />
                </div>
              ))}
            </div>
          </div>
          <div ref={labelRef} className="flex text-micro text-ink-2" style={{ height: BAR_LABEL_HEIGHT }}>
            {items.map((item) => (
              <span key={item.key} className={`min-w-0 flex-1 pt-2 text-center ${item.key === selected?.key ? "font-semibold text-accent" : ""}`}>
                {mode === "full" ? item.label : item.shortLabel ?? shortLabel(item.label)}
              </span>
            ))}
          </div>
        </div>

        {interactive ? (
          <div
            className="absolute inset-y-0 left-0 flex touch-pan-y"
            style={{ right: AXIS_GUTTER }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => { drag.current = null; }}
          >
            {items.map((item) => (
              <button
                key={item.key}
                type="button"
                aria-pressed={item.key === selected?.key}
                aria-label={monthSummary({ label: item.title ?? item.label, income: item.income, expense: item.expense })}
                onClick={(event) => { if (event.detail === 0) onSelect?.(item.key); }}
                className="chart-hit min-w-0 flex-1 rounded-[10px]"
              />
            ))}
          </div>
        ) : null}
      </div>

      {!interactive ? (
        <table className="sr-only">
          <caption>Tulot ja menot kuukausittain</caption>
          <thead>
            <tr><th scope="col">Kuukausi</th><th scope="col">Tulot</th><th scope="col">Menot</th></tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.key}><th scope="row">{item.title ?? item.label}</th><td>{formatEur(item.income)}</td><td>{formatEur(item.expense)}</td></tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </div>
  );
}

function Bar({ value, scale, left, width, tone, animate }: {
  value: number;
  scale: { min: number; max: number };
  left: string;
  width: number;
  tone: string;
  animate: boolean;
}) {
  if (!Number.isFinite(value) || value === 0) return null;
  const rect = barRect(value, scale.min, scale.max);
  return (
    <span
      className={`absolute ${value < 0 ? "origin-top rounded-b-[2px]" : "origin-bottom rounded-t-[2px]"} ${tone} ${animate ? "chart-grow-y" : ""}`}
      style={{ left, width, bottom: `${rect.bottom * 100}%`, height: `${rect.height * 100}%`, minHeight: 2 }}
    />
  );
}
