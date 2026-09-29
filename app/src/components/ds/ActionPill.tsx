import Link from "next/link";
import type { ReactNode } from "react";

// Visually 36px tall (min-h-9) to match the mockup, but a touch target must be at least 44px: the
// `before` pseudo-element adds an invisible hit area extending 4px above and below (-inset-y-1, so
// 36px + 4px + 4px = 44px) without changing anything that's drawn, since it carries no content/background.
// `pointer-events-auto`: when this sits inside a `ListRow`'s `trailing` slot, that slot's wrapper is
// pointer-events-none (so a non-interactive sibling doesn't swallow the row's own click) - this control
// is genuinely interactive and must opt back in, or it stops receiving clicks/taps entirely.
const PILL = "active-press relative pointer-events-auto inline-flex min-h-9 items-center rounded-full bg-accent-soft px-3 text-caption font-semibold text-accent before:absolute before:inset-x-0 before:-inset-y-1 before:content-['']";

export function ActionPill({ children, href, onClick, ariaLabel, disabled }: { children: ReactNode; href?: string; onClick?: () => void; ariaLabel?: string; disabled?: boolean }) {
  if (href) return <Link href={href} aria-label={ariaLabel} className={PILL}>{children}</Link>;
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={ariaLabel} className={`${PILL} disabled:opacity-50`}>
      {children}
    </button>
  );
}
