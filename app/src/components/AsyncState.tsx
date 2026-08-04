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
          className="mt-3 min-h-11 px-4 rounded-xl bg-white border border-danger/30 font-medium hover:bg-danger/5 transition-colors"
        >
          Yritä uudelleen
        </button>
      )}
    </div>
  );
}
