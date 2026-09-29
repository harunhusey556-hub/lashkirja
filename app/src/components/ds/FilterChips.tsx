"use client";

import { hapticSelection } from "@/lib/haptics";

/**
 * Page level (default): one horizontally scrolling row that bleeds to the screen edge.
 * `wrap`: for a short option set inside a card, where the bleed would cut the last chip at the
 * card's edge; the chips wrap onto a second line instead.
 */
export function FilterChips<T extends string>({ label, items, value, onChange, wrap = false }: {
  label: string; items: { id: T; label: string; count?: number | string }[]; value: T; onChange: (id: T) => void;
  wrap?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={wrap ? "flex flex-wrap gap-2" : "-mx-4 flex gap-2 overflow-x-auto px-4 pb-1"}
    >
      {items.map((item) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            aria-pressed={selected}
            onClick={() => {
              if (!selected) void hapticSelection();
              onChange(item.id);
            }}
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
