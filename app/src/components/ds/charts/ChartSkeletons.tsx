import { Skeleton } from "../Skeleton";
import { BAR_LABEL_HEIGHT, BAR_PLOT_HEIGHT } from "./BarChart";

/**
 * Chart placeholders at the FINAL size of the chart they stand in for (QUALITY-BAR L1), so
 * nothing moves when the data lands. Wrap them in a SkeletonGroup like the other skeletons.
 */

/** Same height as BarChart: the sentence line (48 px), the plot and the month labels. */
export function BarChartSkeleton({ className = "" }: { className?: string }) {
  return (
    <div aria-hidden className={className}>
      <div className="flex h-12 items-start">
        <Skeleton tone="soft" className="mt-1 h-3 w-3/5" />
      </div>
      <Skeleton tone="soft" className="w-full" height={BAR_PLOT_HEIGHT + BAR_LABEL_HEIGHT} />
    </div>
  );
}

/** `rows` rows of HBarList (56 px each, divided). */
export function HBarListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div aria-hidden className="divide-y divide-line">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex min-h-14 items-center gap-3 px-4 py-3">
          <Skeleton className="h-3.5 flex-1" />
          <Skeleton className="h-3.5 w-16" />
        </div>
      ))}
    </div>
  );
}

/** The bar (8 px) and a one-line legend (about 44 px) of StackedBar. */
export function StackedBarSkeleton({ className = "" }: { className?: string }) {
  return (
    <div aria-hidden className={className}>
      <Skeleton className="h-2 w-full" radius="full" />
      <div className="mt-3 flex gap-4">
        <Skeleton tone="soft" className="h-9 w-24" />
        <Skeleton tone="soft" className="h-9 w-24" />
      </div>
    </div>
  );
}
