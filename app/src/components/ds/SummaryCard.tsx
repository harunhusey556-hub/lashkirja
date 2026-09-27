import type { ReactNode } from "react";

export function SummaryCard({ label, value, note, noteTone = "accent" }: { label: string; value: ReactNode; note?: ReactNode; noteTone?: "accent" | "muted" }) {
  return (
    <div className="rounded-card border border-line bg-surface p-4">
      <p className="text-[13px] text-ink-2">{label}</p>
      <p className="mt-0.5 text-[28px] font-bold tracking-[-0.02em] tabular-nums text-ink">{value}</p>
      {note ? <p className={`mt-0.5 text-sm ${noteTone === "accent" ? "text-accent" : "text-ink-2"}`}>{note}</p> : null}
    </div>
  );
}
