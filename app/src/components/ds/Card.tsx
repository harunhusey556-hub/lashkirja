import type { ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`ui-card rounded-card border border-line bg-surface p-4 ${className}`}>{children}</div>;
}
