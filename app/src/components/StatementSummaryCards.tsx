import { SummaryCard } from "@/components/ds";
import { formatEur, type StatementTotals } from "@/lib/statement-client";

export default function StatementSummaryCards({ totals }: { totals: StatementTotals }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <SummaryCard label="Tulot" value={<span className="text-success">{formatEur(totals.income)}</span>} />
      <SummaryCard label="Menot" value={<span className="text-accent">{formatEur(totals.expenses)}</span>} />
    </div>
  );
}
