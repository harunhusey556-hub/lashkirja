import type { ReactNode } from "react";

export function Timeline({ items }: { items: { title: string; meta?: ReactNode; tone?: "accent" | "muted" }[] }) {
  return (
    <ol className="rounded-card border border-line bg-surface px-4 py-1">
      {items.map((item, index) => (
        <li key={`${item.title}-${index}`} className="flex gap-3 py-2.5 text-sm">
          <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${item.tone === "accent" ? "bg-accent" : "bg-ink-2"}`} />
          <span>
            <span className="text-ink">{item.title}</span>
            {item.meta ? <span className="mt-0.5 block text-caption text-ink-2">{item.meta}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
