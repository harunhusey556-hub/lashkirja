"use client";

import { Skeleton, SkeletonCard, SkeletonGroup } from "@/components/ds";

/**
 * Final-size loading placeholders for the bookkeeping screens (BOOKS-17, L1).
 * Built from the Wave A `Skeleton` primitives so nothing moves when the data
 * lands; each screen keeps its own title visible above them.
 */

/** DetailHero at its real size: 40 px amount, 17 px title, meta line, tag. */
export function DetailHeroSkeleton() {
  return (
    <div aria-hidden className="flex flex-col items-center px-2 pb-5 pt-2">
      <Skeleton className="mt-1.5 h-9 w-40" />
      <Skeleton className="mt-3 h-4 w-32" />
      <Skeleton tone="soft" className="mt-2 h-3 w-24" />
      <Skeleton radius="full" className="mt-4 h-7 w-24" />
    </div>
  );
}

/** A ds `Section` of `rows` list rows (min-h-16) with a heading. */
export function SectionSkeleton({ rows = 3, heading = true }: { rows?: number; heading?: boolean }) {
  return (
    <div aria-hidden>
      {heading ? <Skeleton className="mx-1 mb-3 h-3 w-28" /> : null}
      <div className="overflow-hidden rounded-card border border-line bg-surface divide-y divide-line">
        {Array.from({ length: rows }).map((_, index) => (
          <div key={index} className="flex min-h-16 items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-3.5 w-2/5" />
              <Skeleton tone="soft" className="h-3 w-3/5" />
            </div>
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Receipt screen: hero, the 192 px preview and the first form fields. */
export function ReceiptDetailSkeleton() {
  return (
    <SkeletonGroup label="Ladataan kuittia" className="space-y-6">
      <DetailHeroSkeleton />
      <SectionSkeleton rows={1} />
      <Skeleton radius="card" className="h-48 w-full" />
      <FieldsSkeleton />
    </SkeletonGroup>
  );
}

/** Labelled 48 px fields, as in the receipt and invoice forms. */
export function FieldsSkeleton({ fields = 3 }: { fields?: number }) {
  return (
    <SkeletonCard className="space-y-4">
      {Array.from({ length: fields }).map((_, index) => (
        <div key={index} className="space-y-2">
          <Skeleton tone="soft" className="h-3 w-20" />
          <Skeleton radius="card" className="h-12 w-full" />
        </div>
      ))}
    </SkeletonCard>
  );
}

/** Statement screen: hero, summary cards and the transaction list. */
export function StatementDetailSkeleton() {
  return (
    <SkeletonGroup label="Ladataan tiliotetta" className="space-y-6">
      <DetailHeroSkeleton />
      <div aria-hidden className="grid grid-cols-2 gap-3">
        {[0, 1].map((card) => (
          <SkeletonCard key={card}>
            <Skeleton className="h-3 w-14" />
            <Skeleton className="mt-3 h-6 w-3/4" />
          </SkeletonCard>
        ))}
      </div>
      <SectionSkeleton rows={4} />
    </SkeletonGroup>
  );
}
