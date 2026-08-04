import { formatEur, type StatementTotals } from "@/lib/statement-client";

export default function StatementSummaryCards({
  totals,
  compact = false,
}: {
  totals: StatementTotals;
  compact?: boolean;
}) {
  const pad = compact ? "py-3 px-3" : "py-4 px-4";
  return (
    <div className={`grid grid-cols-3 gap-3 ${compact ? "" : "sm:gap-4"}`}>
      <div className={`rounded-2xl bg-success/5 border border-success/10 ${pad}`}>
        <p className="text-xs font-medium uppercase tracking-wide text-success/80">
          Tulot
        </p>
        <p
          className={`mt-1.5 font-semibold tabular-nums text-success ${compact ? "text-sm" : "text-base"}`}
        >
          {formatEur(totals.income)}
        </p>
      </div>
      <div className={`rounded-2xl bg-accent/5 border border-accent/10 ${pad}`}>
        <p className="text-xs font-medium uppercase tracking-wide text-accent/80">
          Menot
        </p>
        <p
          className={`mt-1.5 font-semibold tabular-nums text-accent ${compact ? "text-sm" : "text-base"}`}
        >
          {formatEur(totals.expenses)}
        </p>
      </div>
      <div
        className={`rounded-2xl border ${pad} ${
          totals.net >= 0
            ? "bg-success/5 border-success/10"
            : "bg-danger/5 border-danger/10"
        }`}
      >
        <p className="text-xs font-medium uppercase tracking-wide text-warm-gray">
          Netto
        </p>
        <p
          className={`mt-1.5 font-semibold tabular-nums ${compact ? "text-sm" : "text-base"} ${
            totals.net >= 0 ? "text-success" : "text-danger"
          }`}
        >
          {formatEur(totals.net)}
        </p>
      </div>
    </div>
  );
}
