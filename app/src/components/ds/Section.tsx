import type { ReactNode } from "react";

// Section owns the shared grouped-card surface; avoid nesting another card inside it.
export function Section({ title, count, action, children, className = "" }: {
  title?: string; count?: number; action?: ReactNode; children: ReactNode; className?: string;
}) {
  const aside = action ?? (count !== undefined ? <span className="tabular-nums">{count}</span> : null);
  return (
    <section className={`mt-6 first:mt-0 ${className}`}>
      {title || aside ? (
        <div className="mb-2 flex items-baseline justify-between gap-3 px-1 text-caption text-ink-2">
          {title ? <h2 className="font-normal">{title}</h2> : <span />}
          {aside}
        </div>
      ) : null}
      <div className="ui-card overflow-hidden rounded-card border border-line bg-surface divide-y divide-line">{children}</div>
    </section>
  );
}
