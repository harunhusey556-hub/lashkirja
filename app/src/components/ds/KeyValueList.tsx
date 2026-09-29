import type { ReactNode } from "react";

export function KeyValueList({ rows }: { rows: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="overflow-hidden rounded-card border border-line bg-surface divide-y divide-line">
      {rows.map((row) => (
        <div key={row.label} className="flex justify-between gap-3 px-4 py-3 text-body">
          <dt className="text-ink-2">{row.label}</dt>
          <dd className="min-w-0 text-right font-medium text-ink">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
