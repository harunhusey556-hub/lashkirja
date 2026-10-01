import Link from "next/link";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { ActionPill } from "./ActionPill";
import { Icon, IconTile } from "./Icon";

// `muted` is for a non-money value in the amount slot ("1 avoin", a bank name), as in the mockups.
const AMOUNT_TONE = { default: "text-ink", positive: "text-success", negative: "text-ink", muted: "text-ink-2" } as const;

/**
 * `leading` is the bare glyph (`<Icon icon={Landmark} />`); the row wraps it in the shared 36px
 * `IconTile`. Within one `Section`, give either every row a leading icon or none.
 * `chevron` marks a row that navigates to another screen (hub and settings-style rows), as in the
 * mockups; record rows (a transaction, an invoice) leave it off. A chevron row's secondary line may wrap
 * to two lines.
 */
export function ListRow({ title, amount, amountTone = "default", secondary, secondaryLines = "clamp", trailing, leading, chevron = false, href, onClick, ariaLabel }: {
  title: string; amount?: ReactNode; amountTone?: keyof typeof AMOUNT_TONE; secondary?: ReactNode;
  /** "all" shows the whole secondary text and drops the trailing action to its own line: for a failure whose last sentence is the advice (F29). */
  secondaryLines?: "clamp" | "all";
  trailing?: ReactNode; leading?: ReactNode; chevron?: boolean; href?: string; onClick?: () => void; ariaLabel?: string;
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

  // A row never carries a second link to its own href (AX-13, R4): an ActionPill that would navigate to
  // the same place is drawn as a decorative pill, and the row's link carries the tap.
  const trailingNode =
    href && isValidElement(trailing) && trailing.type === ActionPill && (trailing.props as { href?: string }).href === href
      ? cloneElement(trailing as ReactElement<{ decorative?: boolean }>, { decorative: true })
      : trailing;

  const body = (
    <>
      {leading ? <IconTile>{leading}</IconTile> : null}
      <span className="pointer-events-none min-w-0 flex-1">
        {/* Hidden from screen readers while the row is interactive: this text is already the overlay
            link/button's accessible name above, and linear reading would otherwise announce it twice. */}
        {/* R19 / AX-02: the title keeps at least ~7 characters' width (in em, so it grows with the
            text size); when the amount no longer fits beside it, the amount wraps under it,
            right-aligned. Titles and secondary lines wrap to two lines instead of being cut (AX-26). */}
        <span aria-hidden={interactive || undefined} className="flex flex-wrap items-baseline justify-between gap-x-3 text-body font-medium text-ink">
          <span className="min-w-0 clamp-lines [flex:1_1_7em] [overflow-wrap:anywhere]">{title}</span>
          {amount !== undefined ? <span className={`ml-auto shrink-0 tabular-nums ${AMOUNT_TONE[amountTone]}`}>{amount}</span> : null}
        </span>
        {secondary || trailingNode ? (
          <span className="mt-0.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span
              aria-hidden={interactive || undefined}
              className={
                secondaryLines === "all"
                  ? "min-w-0 basis-full text-caption text-ink-2 [overflow-wrap:anywhere]"
                  : "min-w-0 clamp-lines text-caption text-ink-2 [flex:1_1_9em]"
              }
            >
              {secondary}
            </span>
            {/* trailing (e.g. an ActionPill) stays outside the aria-hidden text above: it is its own
                interactive control and must remain reachable and named for assistive tech. The wrapper
                itself is pointer-events-none: a non-interactive trailing element (a plain StatusTag) must
                let taps fall through to the row's own stretched link/button underneath, or it silently
                swallows the row's own click - the wrapper only exists to lift z-index above that overlay,
                not to grab clicks. An interactive trailing element (ActionPill, MoreMenu's trigger) opts
                back in with its own `pointer-events-auto`. */}
            {trailingNode ? <span className="pointer-events-none relative z-10 ml-auto shrink-0">{trailingNode}</span> : null}
          </span>
        ) : null}
      </span>
      {chevron ? (
        <span aria-hidden className="pointer-events-none -mr-1 flex text-ink-2/80">
          <Icon icon={ChevronRight} />
        </span>
      ) : null}
    </>
  );
  const row = "relative flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left";
  if (href) {
    return (
      <div data-testid="list-row" className={row}>
        <Link href={href} aria-label={composedLabel} className="row-link active-press absolute inset-0" />
        {body}
      </div>
    );
  }
  if (onClick) {
    return (
      <div data-testid="list-row" className={row}>
        <button type="button" onClick={onClick} aria-label={composedLabel} className="row-link active-press absolute inset-0" />
        {body}
      </div>
    );
  }
  return (
    <div data-testid="list-row" className={row}>
      {body}
    </div>
  );
}
