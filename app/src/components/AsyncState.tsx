"use client";

export function LoadingState({
  label = "Ladataan...",
  compact = false,
}: {
  label?: string;
  compact?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-center gap-3 text-sm text-warm-gray ${compact ? "py-8" : "py-20"}`}
      role="status"
      aria-live="polite"
    >
      <span
        className="w-7 h-7 border-2 border-accent border-t-transparent rounded-full animate-spin motion-reduce:animate-none"
        aria-hidden="true"
      />
      <span>{label}</span>
    </div>
  );
}

/**
 * Content-shaped loading placeholder for list pages: shimmering rows that
 * arrive with the same stagger the real list uses, so the swap reads as the
 * data filling in rather than a spinner being replaced by a page.
 */
export function SkeletonList({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-3 list-stagger" role="status" aria-label="Ladataan…">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="rounded-card border border-line bg-surface p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-warm-gray-light/30 skeleton shrink-0" />
            <div className="flex-1 space-y-2 min-w-0">
              <div className="h-3.5 w-2/5 bg-warm-gray-light/30 rounded skeleton" />
              <div className="h-3 w-3/5 bg-warm-gray-light/20 rounded skeleton" />
            </div>
            <div className="h-4 w-14 bg-warm-gray-light/30 rounded skeleton shrink-0" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function ErrorState({
  message,
  onRetry,
  compact = false,
}: {
  message: string;
  onRetry?: () => void;
  compact?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl bg-danger/10 text-danger text-sm text-center ${compact ? "p-4" : "p-6"}`}
      role="alert"
    >
      <p>{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-3 min-h-11 px-4 rounded-xl bg-surface border border-danger/30 font-medium hover:bg-danger/5 transition-colors"
        >
          Yritä uudelleen
        </button>
      )}
    </div>
  );
}
