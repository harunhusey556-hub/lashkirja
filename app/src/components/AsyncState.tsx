"use client";

import { ConnectionNotice } from "@/components/ScreenState";
import { Skeleton, SkeletonGroup } from "@/components/ds/Skeleton";

/**
 * Loading (VS-33): a `ds/Skeleton` at the final layout, never a spinner in empty
 * space and never a "Ladataan…" line next to it. The label is only for screen
 * readers ("Ladataan …": the one verb, whatever the source). Spinners live inside
 * a button or an image, nowhere else.
 */

/** One record row (type B) at its final height: title and amount, then the meta line. */
function SkeletonRow() {
  return (
    <div className="flex min-h-16 flex-col justify-center gap-1.5 px-4 py-3" aria-hidden>
      <div className="flex items-center justify-between gap-3">
        <Skeleton className="h-4 w-2/5" />
        <Skeleton className="h-4 w-16" />
      </div>
      <Skeleton tone="soft" className="h-3 w-3/5" />
    </div>
  );
}

/**
 * Content-shaped loading placeholder for list pages: the rows sit in one card with
 * dividers, like the real `Section`, so nothing moves when the data lands.
 */
export function SkeletonList({ rows = 5, label = "Ladataan" }: { rows?: number; label?: string }) {
  return (
    <SkeletonGroup label={label}>
      <div className="overflow-hidden rounded-card border border-line bg-surface divide-y divide-line">
        {Array.from({ length: rows }).map((_, index) => (
          <SkeletonRow key={index} />
        ))}
      </div>
    </SkeletonGroup>
  );
}

/**
 * The same placeholder for an inline fetch (a balance, a suggestion list) that has no page
 * skeleton of its own. Same look as `SkeletonList`, fewer rows by default.
 */
export function LoadingState({
  label = "Ladataan",
  rows = 2,
}: {
  label?: string;
  rows?: number;
  /** Kept for callers; there is no separate compact size any more. */
  compact?: boolean;
}) {
  return <SkeletonList rows={rows} label={label} />;
}

/**
 * Failure card with ONE retry, in the place of the content. Pass `error`
 * (preferred) and it classifies the failure exactly like ConnectionNotice
 * (offline / unreachable / expired / generic, Finnish copy only); pass only
 * `message` for a failure the caller has already put into words. Same card and
 * title ("Jotain meni pieleen") in both cases; `title` replaces the title for
 * a failure with its own words (a receipt that does not exist).
 */
export function ErrorState({
  message,
  error,
  title,
  onRetry,
  compact = false,
}: {
  message?: string;
  error?: unknown;
  title?: string;
  onRetry?: () => void;
  compact?: boolean;
}) {
  const failure = error !== undefined && error !== null ? error : new Error(message || "Lataus epäonnistui");
  return (
    <ConnectionNotice
      error={failure}
      fallback={message || "Lataus epäonnistui"}
      onRetry={onRetry}
      title={title}
      compact={compact}
    />
  );
}
