"use client";

import { segmentFill } from "./geometry";
import { useGrowOnce } from "./hooks";

/**
 * The month bar of the approved Koti mockup: up to 12 pill segments, done in
 * the success tone, the rest neutral. It draws only the bar; the visible text
 * ("38 / 41 kunnossa") belongs to the caller, next to it.
 *
 * Props
 * - done, total: how many items are in order of how many there are. total 0 draws nothing.
 *   With more than 12 items the bar shows 12 pills in proportion and never lies at the ends
 *   (full only when everything is done, empty only when nothing is).
 * - label: one sentence for assistive tech ("38 tapahtumaa 41:stä on kunnossa"). The bar is role="img".
 * - animateKey: with a key the bar fades in only the first time this session.
 *
 * Use it where a share of a countable whole is the point: the month's events on Koti.
 * Not for money (use StackedBar) and not for trends (use Sparkline).
 */
export function SegmentedProgress({ done, total, label, animateKey, className = "" }: {
  done: number;
  total: number;
  label: string;
  animateKey?: string;
  className?: string;
}) {
  const animate = useGrowOnce(animateKey);
  const { segments, filled } = segmentFill(done, total);
  if (segments === 0) return null;
  return (
    <div role="img" aria-label={label} className={`flex h-2 gap-[3px] ${animate ? "chart-fade" : ""} ${className}`}>
      {Array.from({ length: segments }, (_, index) => (
        <span key={index} aria-hidden className={`h-full min-w-0 flex-1 rounded-full ${index < filled ? "bg-success" : "bg-line"}`} />
      ))}
    </div>
  );
}
