import Link from "next/link";
import type { ReactNode } from "react";

const AMOUNT_TONE = { default: "text-ink", positive: "text-success", negative: "text-ink" } as const;

export function ListRow({ title, amount, amountTone = "default", secondary, trailing, leading, href, onClick, ariaLabel }: {
  title: string; amount?: ReactNode; amountTone?: keyof typeof AMOUNT_TONE; secondary?: ReactNode;
  trailing?: ReactNode; leading?: ReactNode; href?: string; onClick?: () => void; ariaLabel?: string;
}) {
  const interactive = Boolean(href || onClick);
  // The overlay link/button below needs one accessible name that actually distinguishes financial rows —
  // the title alone is not unique (many rows share a customer name), and it's exactly the amount/status
  // that tells rows apart. Compose it from the visible parts that are plain strings. A `ReactNode` amount
  // or secondary (e.g. a formatted element, not a bare string) is skipped here, so callers MUST pass
  // `ariaLabel` explicitly whenever amount or secondary is not a plain string.
  const composedLabel =
    ariaLabel ??
    [title, typeof amount === "string" ? amount : null, typeof secondary === "string" ? secondary : null]
      .filter((part): part is string => Boolean(part))
      .join(", ");

  const body = (
    <>
      {leading ? (
        <span aria-hidden className="pointer-events-none flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-canvas text-ink-2">
          {leading}
        </span>
      ) : null}
      <span className="pointer-events-none min-w-0 flex-1">
        {/* Hidden from screen readers while the row is interactive: this text is already the overlay
            link/button's accessible name above, and linear reading would otherwise announce it twice. */}
        <span aria-hidden={interactive || undefined} className="flex items-baseline justify-between gap-3 text-[15px] font-medium text-ink">
          <span className="min-w-0 truncate">{title}</span>
          {amount !== undefined ? <span className={`shrink-0 tabular-nums ${AMOUNT_TONE[amountTone]}`}>{amount}</span> : null}
        </span>
        {secondary || trailing ? (
          <span className="mt-0.5 flex items-center justify-between gap-3">
            <span aria-hidden={interactive || undefined} className="min-w-0 truncate text-[13px] text-ink-2">{secondary}</span>
            {/* trailing (e.g. an ActionPill) stays outside the aria-hidden text above: it is its own
                interactive control and must remain reachable and named for assistive tech. */}
            {trailing ? <span className="pointer-events-auto relative z-10 shrink-0">{trailing}</span> : null}
          </span>
        ) : null}
      </span>
    </>
  );
  const row = "relative flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left";
  if (href) {
    return (
      <div className={row}>
        <Link href={href} aria-label={composedLabel} className="row-link active-press absolute inset-0" />
        {body}
      </div>
    );
  }
  if (onClick) {
    return (
      <div className={row}>
        <button type="button" onClick={onClick} aria-label={composedLabel} className="row-link active-press absolute inset-0" />
        {body}
      </div>
    );
  }
  return <div className={row}>{body}</div>;
}
