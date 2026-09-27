import type { ReactNode } from "react";

export function PageTitle({ title, subtitle, action }: { title: string; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <header className="mb-5 flex items-end justify-between gap-3 px-1">
      <div className="min-w-0">
        <h1 className="text-[32px] font-bold leading-tight tracking-[-0.02em] text-ink [text-wrap:balance]">{title}</h1>
        {subtitle ? <p className="mt-0.5 text-[15px] text-ink-2">{subtitle}</p> : null}
      </div>
      {action ? <div className="shrink-0 pb-1">{action}</div> : null}
    </header>
  );
}
