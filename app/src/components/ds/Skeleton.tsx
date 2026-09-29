"use client";

import { useState, type CSSProperties, type ReactNode } from "react";

/**
 * Loading placeholders at FINAL size (QUALITY-BAR L1). A page builds its
 * skeleton from these so nothing moves when the data lands:
 *
 *   <SkeletonGroup label="Ladataan laskuja">
 *     <SkeletonCard>
 *       <Skeleton className="h-3.5 w-2/5" />
 *       <Skeleton className="mt-2 h-7 w-1/2" />
 *     </SkeletonCard>
 *   </SkeletonGroup>
 *
 * and fades the real content in only when it replaced a skeleton:
 *
 *   const fade = useSkeletonFade(!data);
 *   return data ? <div className={fade}>…</div> : <MySkeleton />;
 *
 * The shimmer is `.skeleton` in globals.css (1.6 s linear, off under
 * reduced motion). Bars are decorative (`aria-hidden`); the group carries
 * one `role="status"` label for screen readers.
 */

type Radius = "bar" | "card" | "full";

const RADIUS: Record<Radius, string> = {
  bar: "rounded",
  card: "rounded-card",
  full: "rounded-full",
};

/** One shimmering block. Size it with Tailwind classes or width/height. */
export function Skeleton({
  className = "",
  width,
  height,
  radius = "bar",
  tone = "strong",
}: {
  className?: string;
  width?: CSSProperties["width"];
  height?: CSSProperties["height"];
  radius?: Radius;
  /** strong = primary line (bg-line/70), soft = secondary line (bg-line/50). */
  tone?: "strong" | "soft";
}) {
  return (
    <div
      aria-hidden
      className={`skeleton ${tone === "strong" ? "bg-line/70" : "bg-line/50"} ${RADIUS[radius]} ${className}`}
      style={width !== undefined || height !== undefined ? { width, height } : undefined}
    />
  );
}

/** A few text lines; the last one shorter, like real copy. */
export function SkeletonText({ lines = 2, className = "" }: { lines?: number; className?: string }) {
  return (
    <div aria-hidden className={`space-y-2 ${className}`}>
      {Array.from({ length: lines }).map((_, index) => (
        <Skeleton
          key={index}
          tone={index === 0 ? "strong" : "soft"}
          className={`h-3 ${index === lines - 1 && lines > 1 ? "w-3/5" : "w-full"}`}
        />
      ))}
    </div>
  );
}

/** The card chrome (same border, radius and padding as ds/Card). */
export function SkeletonCard({ className = "", children }: { className?: string; children?: ReactNode }) {
  return (
    <div aria-hidden className={`rounded-card border border-line bg-surface p-4 ${className}`}>
      {children}
    </div>
  );
}

/** Wraps a page's skeleton: one polite status for assistive tech. */
export function SkeletonGroup({
  label = "Ladataan…",
  className = "",
  children,
}: {
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" aria-label={label} className={className}>
      {children}
    </div>
  );
}

/**
 * Returns "fade-in-content" (opacity 0 to 1, --dur-pop, --ease-out) once the
 * content replaces a skeleton this component actually showed; "" when the
 * content was there from the first render (a cache hit never fades).
 */
export function useSkeletonFade(loading: boolean): string {
  const [showedSkeleton, setShowedSkeleton] = useState(loading);
  if (loading && !showedSkeleton) setShowedSkeleton(true);
  return !loading && showedSkeleton ? "fade-in-content" : "";
}

/**
 * Koti's summary cards at their final sizes (SHELL-34): Tulot and Menot
 * side by side, the ALV estimate full width with its note line. Matches
 * ds/SummaryCard (label 13 px, value 28 px, note 14 px).
 */
export function DashboardCardsSkeleton() {
  const card = (withNote: boolean, span: string) => (
    <SkeletonCard className={span}>
      <Skeleton className="mt-1 h-3 w-12" />
      <Skeleton className="mt-3 h-7 w-3/4" />
      {withNote ? <Skeleton tone="soft" className="mt-3 h-3 w-24" /> : <div className="h-1" />}
    </SkeletonCard>
  );
  return (
    <SkeletonGroup label="Ladataan kuukauden lukuja" className="grid grid-cols-2 gap-3">
      {card(false, "")}
      {card(false, "")}
      {card(true, "col-span-2")}
    </SkeletonGroup>
  );
}
