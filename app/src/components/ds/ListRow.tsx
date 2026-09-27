import Link from "next/link";
import type { ReactNode } from "react";

const AMOUNT_TONE = { default: "text-ink", positive: "text-success", negative: "text-ink" } as const;

export function ListRow({ title, amount, amountTone = "default", secondary, trailing, leading, href, onClick, ariaLabel }: {
  title: string; amount?: ReactNode; amountTone?: keyof typeof AMOUNT_TONE; secondary?: ReactNode;
  trailing?: ReactNode; leading?: ReactNode; href?: string; onClick?: () => void; ariaLabel?: string;
}) {
  const body = (
    <>
      {leading ? (
        <span aria-hidden className="pointer-events-none flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[10px] bg-canvas text-ink-2">
          {leading}
        </span>
      ) : null}
      <span className="pointer-events-none min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-3 text-[15px] font-medium text-ink">
          <span className="min-w-0 truncate">{title}</span>
          {amount !== undefined ? <span className={`shrink-0 tabular-nums ${AMOUNT_TONE[amountTone]}`}>{amount}</span> : null}
        </span>
        {secondary || trailing ? (
          <span className="mt-0.5 flex items-center justify-between gap-3">
            <span className="min-w-0 truncate text-[13px] text-ink-2">{secondary}</span>
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
        <Link href={href} aria-label={ariaLabel ?? title} className="row-link active-press absolute inset-0" />
        {body}
      </div>
    );
  }
  if (onClick) {
    return (
      <div className={row}>
        <button type="button" onClick={onClick} aria-label={ariaLabel ?? title} className="row-link active-press absolute inset-0" />
        {body}
      </div>
    );
  }
  return <div className={row}>{body}</div>;
}
