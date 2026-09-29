import type { ReactNode } from "react";

export function PageTitle({ title, subtitle, action }: { title: string; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    // The action is centred on the title's first line (40px line box, 36px pill: 2px down), not on
    // the bottom of the subtitle, so it lines up the same with or without a subtitle.
    <header className="mb-5 flex items-start justify-between gap-3 px-1">
      <div className="min-w-0">
        <h1 className="text-title font-bold leading-tight tracking-[-0.02em] text-ink [text-wrap:balance]">{title}</h1>
        {subtitle ? <p className="mt-0.5 text-body text-ink-2">{subtitle}</p> : null}
      </div>
      {action ? <div className="shrink-0 pt-0.5">{action}</div> : null}
    </header>
  );
}
