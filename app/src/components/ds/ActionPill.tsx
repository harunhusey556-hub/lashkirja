import Link from "next/link";
import type { ReactNode } from "react";

// Visually 36px tall (min-h-9) to match the mockup, but a touch target must be at least 44px: the
// `before` pseudo-element adds an invisible hit area extending 4px above and below (-inset-y-1, so
// 36px + 4px + 4px = 44px) without changing anything that's drawn, since it carries no content/background.
const PILL = "active-press relative inline-flex min-h-9 items-center rounded-full bg-accent-soft px-3 text-[13px] font-semibold text-accent before:absolute before:inset-x-0 before:-inset-y-1 before:content-['']";

export function ActionPill({ children, href, onClick, ariaLabel }: { children: ReactNode; href?: string; onClick?: () => void; ariaLabel?: string }) {
  if (href) return <Link href={href} aria-label={ariaLabel} className={PILL}>{children}</Link>;
  return <button type="button" onClick={onClick} aria-label={ariaLabel} className={PILL}>{children}</button>;
}
