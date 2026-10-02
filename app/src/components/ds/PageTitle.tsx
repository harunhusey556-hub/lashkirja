"use client";

import type { ReactNode } from "react";
import { usePageHeaderActions } from "@/components/PageHeaderActions";

export function PageTitle({ title, subtitle, action }: { title: string; subtitle?: ReactNode; action?: ReactNode }) {
  const headerActions = usePageHeaderActions();
  return (
    // The action is centred on the title's first line (40px line box, 36px pill: 2px down), not on
    // the bottom of the subtitle, so it lines up the same with or without a subtitle.
    // At a large iOS text size the action (e.g. the month stepper) wraps under
    // the title instead of overlapping it, and a long word breaks rather than
    // leaving the screen (AX-02, R19).
    <header className="page-title mb-5 flex flex-wrap items-start justify-between gap-x-3 gap-y-2 px-1">
      <div className="min-w-0 [flex:1_1_calc(var(--text-title)*4.5)]">
        <h1 className="text-title font-semibold leading-tight tracking-[-0.02em] text-ink [text-wrap:balance] [overflow-wrap:anywhere]">{title}</h1>
        {subtitle ? <p className="mt-0.5 text-body text-ink-2">{subtitle}</p> : null}
      </div>
      {headerActions ? <div className="page-title-actions shrink-0">{headerActions}</div> : null}
      {action ? <div className={headerActions ? "page-title-accessory basis-full" : "shrink-0 pt-0.5"}>{action}</div> : null}
    </header>
  );
}
