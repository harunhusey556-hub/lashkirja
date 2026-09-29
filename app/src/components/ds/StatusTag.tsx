import type { ReactNode } from "react";
import type { Tone } from "@/lib/status-labels";

const TONE: Record<Tone, string> = {
  // `line`, not `canvas`: a canvas pill vanishes on the canvas page behind DetailHero.
  neutral: "bg-line/70 text-ink-2",
  accent: "bg-accent-soft text-accent",
  danger: "bg-danger/10 text-danger",
  // success-dark on the tint: plain success is 4.30:1 over the canvas (R13, AX-09).
  success: "bg-success/10 text-success-dark",
  // warning-dark on the tint: 4.42:1 with plain warning (AX-09, R13).
  warning: "bg-warning/10 text-warning-dark",
};

export function StatusTag({ tone, children, icon }: { tone: Tone; children: ReactNode; icon?: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-caption font-semibold ${TONE[tone]}`}>
      {icon ? <span aria-hidden className="flex">{icon}</span> : null}
      {children}
    </span>
  );
}
