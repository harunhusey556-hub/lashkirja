import Link from "next/link";
import type { ReactNode } from "react";

const PILL = "active-press inline-flex min-h-9 items-center rounded-full bg-accent-soft px-3 text-[13px] font-semibold text-accent";

export function ActionPill({ children, href, onClick, ariaLabel }: { children: ReactNode; href?: string; onClick?: () => void; ariaLabel?: string }) {
  if (href) return <Link href={href} aria-label={ariaLabel} className={PILL}>{children}</Link>;
  return <button type="button" onClick={onClick} aria-label={ariaLabel} className={PILL}>{children}</button>;
}
