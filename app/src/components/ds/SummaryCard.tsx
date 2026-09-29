import type { ReactNode } from "react";

export function SummaryCard({ label, value, note, noteTone = "accent" }: { label: string; value: ReactNode; note?: ReactNode; noteTone?: "accent" | "muted" }) {
  return (
    // The amount is capped by the card's own width (container query), so two
    // cards side by side never spill at a large iOS text size (AX-02); at the
    // default size it is the plain 28 px token.
    <div className="rounded-card border border-line bg-surface p-4 [container-type:inline-size]">
      <p className="text-caption text-ink-2">{label}</p>
      <p className="mt-0.5 text-[length:min(var(--text-title-2),21cqi)] font-bold tracking-[-0.02em] tabular-nums text-ink">{value}</p>
      {note ? <p className={`mt-0.5 text-sm ${noteTone === "accent" ? "text-accent" : "text-ink-2"}`}>{note}</p> : null}
    </div>
  );
}
