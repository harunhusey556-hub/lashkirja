"use client";

import { formatEur } from "@/lib/format";
import { stackShares } from "./geometry";
import { useGrowOnce } from "./hooks";

/**
 * One bar split into the parts of a whole, with a legend row of amount and label under it.
 *
 * Props
 * - segments: { key, label, valueCents, tone }. Order is the order on screen. Zero and negative
 *   values are left out of both the bar and the legend. A small non-zero part keeps a minimum
 *   width so it stays visible. tone: "success" | "neutral" | "accent" | "danger".
 *   For Myynti: maksettu (success), odottaa maksua (neutral), myöhässä (danger).
 * - emptyText: the one calm sentence shown instead of a bar when the total is zero.
 * - animateKey: with a key the bar grows in only the first time this session.
 *
 * - onSelect(key): makes every segment and legend entry a button (the legend entries are the
 *   accessible ones; the bar segments are a larger target for the thumb). selectedKey dims the rest.
 *
 * Colour never carries the meaning alone: every segment has its amount and name printed in the
 * legend, and the bar is role="img" with the same figures as one sentence.
 * Use it for a few parts of one amount (sales by payment state). For many categories use HBarList.
 */

const TONE = {
  success: "bg-success",
  neutral: "bg-ink-2/70",
  accent: "bg-accent",
  danger: "bg-danger",
} as const;

export type StackedTone = keyof typeof TONE;
export type StackedSegment = { key: string; label: string; valueCents: number; tone: StackedTone };

export function StackedBar({ segments, emptyText, animateKey, ariaLabel, onSelect, selectedKey, className = "" }: {
  segments: readonly StackedSegment[];
  onSelect?: (key: string) => void;
  selectedKey?: string | null;
  emptyText?: string;
  animateKey?: string;
  ariaLabel?: string;
  className?: string;
}) {
  const animate = useGrowOnce(animateKey);
  const shown = segments.filter((segment) => Number.isFinite(segment.valueCents) && segment.valueCents > 0);
  if (shown.length === 0) {
    return emptyText ? <p className={`text-body text-ink-2 ${className}`}>{emptyText}</p> : null;
  }
  const shares = stackShares(shown.map((segment) => segment.valueCents));
  const summary =
    ariaLabel ?? shown.map((segment) => `${segment.label} ${formatEur(segment.valueCents / 100)}`).join(", ") + ".";
  if (onSelect) {
    return (
      <div className={className}>
        <div aria-hidden className={`flex h-6 origin-left items-center gap-[3px] ${animate ? "chart-grow-x" : ""}`}>
          {shown.map((segment, index) => (
            <button
              key={segment.key}
              type="button"
              tabIndex={-1}
              onClick={() => onSelect(segment.key)}
              className={`flex h-full min-w-0 items-center transition-opacity duration-[var(--dur-pop)] ${selectedKey && selectedKey !== segment.key ? "opacity-35" : ""}`}
              style={{ flex: `${shares[index]} 1 0%` }}
            >
              <span className={`block h-2 w-full rounded-full ${TONE[segment.tone]}`} />
            </button>
          ))}
        </div>
        <ul className="mt-1 flex flex-wrap gap-x-2">
          {shown.map((segment) => (
            <li key={segment.key} className="min-w-0">
              <button
                type="button"
                aria-pressed={selectedKey === segment.key}
                aria-label={`${segment.label} ${formatEur(segment.valueCents / 100)}`}
                onClick={() => onSelect(segment.key)}
                className={`active-press block min-h-11 min-w-0 text-left text-caption text-ink-2 transition-opacity duration-[var(--dur-pop)] ${selectedKey && selectedKey !== segment.key ? "opacity-60" : ""}`}
              >
                <span className="flex items-center gap-1">
                  <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${TONE[segment.tone]}`} />
                  <span className="min-w-0">{segment.label}</span>
                </span>
                <span className="mt-0.5 block text-body font-semibold tabular-nums text-ink">{formatEur(segment.valueCents / 100)}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }
  return (
    <div className={className}>
      <div role="img" aria-label={summary} className={`flex h-2 origin-left gap-[3px] ${animate ? "chart-grow-x" : ""}`}>
        {shown.map((segment, index) => (
          <span
            key={segment.key}
            aria-hidden
            className={`h-full min-w-0 rounded-full ${TONE[segment.tone]}`}
            style={{ flex: `${shares[index]} 1 0%` }}
          />
        ))}
      </div>
      <ul aria-hidden className="mt-3 flex flex-wrap gap-x-5 gap-y-2.5">
        {shown.map((segment) => (
          <li key={segment.key} className="min-w-0 text-caption text-ink-2">
            <span className="flex items-center gap-1.5">
              <span className={`h-2 w-2 shrink-0 rounded-full ${TONE[segment.tone]}`} />
              <span className="min-w-0">{segment.label}</span>
            </span>
            <span className="mt-0.5 block pl-3.5 text-body font-semibold tabular-nums text-ink">{formatEur(segment.valueCents / 100)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
