"use client";

import { useGrowOnce } from "@/components/ds/charts/hooks";
import { monthCloseDoneText } from "@/lib/month-close";

/**
 * The quiet end of a month: a check that draws itself once, one sentence and
 * one supporting line. No confetti. The caller shows it only for a closed
 * month that was truly complete (monthCloseComplete).
 */
export function MonthDone({ month, name }: { month: string; name: string }) {
  const animate = useGrowOnce(`month-done:${month}`);
  const { title, support } = monthCloseDoneText(name);
  return (
    <div className="rounded-card border border-line bg-surface px-4 py-6 text-center" role="status">
      <svg
        viewBox="0 0 48 48"
        width="48"
        height="48"
        aria-hidden
        className="mx-auto text-success"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="24" cy="24" r="21" className={animate ? "check-ring" : undefined} />
        <path d="M15 25 l6.5 6.5 L33 18.5" pathLength={1} className={animate ? "check-draw" : undefined} />
      </svg>
      <p className="mt-3 text-headline font-semibold text-ink">{title}</p>
      <p className="mt-0.5 text-body text-ink-2">{support}</p>
    </div>
  );
}
