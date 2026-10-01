"use client";

import { sparkGeometry } from "./geometry";
import { useGrowOnce } from "./hooks";

/**
 * A quiet 1.5 px trend line with its last point marked. Small enough to sit beside a figure,
 * for a bank balance over the last weeks.
 *
 * Props
 * - points: the values in time order (any unit; only the shape is drawn). Fewer than two points
 *   draws a lone dot, none draws nothing. All-equal values draw a flat line.
 * - ariaLabel: one sentence that says what the line shows ("Saldo viimeiset 30 päivää: nousi 120,00 €").
 *   The line is role="img"; the figure it accompanies stays printed next to it.
 * - tone: "neutral" (default), "success" or "accent".
 * - height (px, default 32). The width is the parent's.
 * - animateKey: with a key the line fades in only the first time this session.
 *
 * Use it where the direction matters more than the exact values. It has no axis: do not use it
 * where the reader has to read amounts off the picture (use BarChart).
 */

const TONE = {
  neutral: "text-ink-2",
  success: "text-success",
  accent: "text-accent",
} as const;

export function Sparkline({ points, ariaLabel, tone = "neutral", height = 32, animateKey, className = "" }: {
  points: readonly number[];
  ariaLabel: string;
  tone?: keyof typeof TONE;
  height?: number;
  animateKey?: string;
  className?: string;
}) {
  const animate = useGrowOnce(animateKey);
  const geometry = sparkGeometry(points);
  if (!geometry) return null;
  return (
    <div role="img" aria-label={ariaLabel} className={`relative w-full ${TONE[tone]} ${animate ? "chart-fade" : ""} ${className}`} style={{ height }}>
      {geometry.path ? (
        <svg aria-hidden viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible">
          <path d={geometry.path} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
        </svg>
      ) : null}
      <span
        aria-hidden
        className="absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current"
        style={{ left: `${geometry.last.x}%`, top: `${geometry.last.y}%` }}
      />
    </div>
  );
}
