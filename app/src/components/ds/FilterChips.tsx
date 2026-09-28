"use client";

export function FilterChips<T extends string>({ label, items, value, onChange }: {
  label: string; items: { id: T; label: string; count?: number | string }[]; value: T; onChange: (id: T) => void;
}) {
  return (
    <div role="group" aria-label={label} className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
      {items.map((item) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(item.id)}
            className={`ds-chip active-press inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium ${
              selected ? "border-ink bg-ink text-canvas" : "border-line bg-surface text-ink"
            }`}
          >
            {item.label}
            {item.count !== undefined ? (
              <span className={`tabular-nums ${selected ? "text-canvas/70" : "text-ink-2"}`}>{item.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
