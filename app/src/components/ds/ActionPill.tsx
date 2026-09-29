import Link from "next/link";
import type { ReactNode } from "react";

// Visually 36px tall (min-h-9) to match the mockup, but a touch target must be at least 44px: the
// `before` pseudo-element adds an invisible hit area extending 4px above and below (-inset-y-1, so
// 36px + 4px + 4px = 44px) without changing anything that's drawn, since it carries no content/background.
// `pointer-events-auto`: when this sits inside a `ListRow`'s `trailing` slot, that slot's wrapper is
// pointer-events-none (so a non-interactive sibling doesn't swallow the row's own click) - this control
// is genuinely interactive and must opt back in, or it stops receiving clicks/taps entirely.
const PILL = "active-press relative pointer-events-auto inline-flex min-h-9 items-center rounded-full bg-accent-soft px-3 text-caption font-semibold text-accent before:absolute before:inset-x-0 before:-inset-y-1 before:content-['']";

/**
 * One label, one role, one effect (AX-13, R4). A pill that acts in place is a `button`. A pill that
 * navigates is a `link` whose name starts with "Avaa: " and still contains the visible word (WCAG 2.5.3).
 * `decorative` draws the pill without a control of its own: `ListRow` sets it when the row already links
 * to the same href, because a row never carries a second link to the same place (its taps fall through
 * to the row's link).
 */
export function linkPillName(ariaLabel: string | undefined): string | undefined {
  if (!ariaLabel) return undefined;
  return /^Avaa\b/.test(ariaLabel) ? ariaLabel : `Avaa: ${ariaLabel}`;
}

export function ActionPill({ children, href, onClick, ariaLabel, disabled, decorative }: { children: ReactNode; href?: string; onClick?: () => void; ariaLabel?: string; disabled?: boolean; decorative?: boolean }) {
  if (href && decorative) {
    return <span aria-hidden="true" className={PILL.replace("pointer-events-auto", "pointer-events-none").replace("active-press ", "")}>{children}</span>;
  }
  if (href) return <Link href={href} aria-label={linkPillName(ariaLabel)} className={PILL}>{children}</Link>;
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={ariaLabel} className={`${PILL} disabled:opacity-50`}>
      {children}
    </button>
  );
}
