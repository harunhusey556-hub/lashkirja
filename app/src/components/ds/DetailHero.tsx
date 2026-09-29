import type { ReactNode } from "react";

const TONE = { default: "text-ink", positive: "text-success", negative: "text-ink" } as const;

/**
 * The hero amount is capped by the hero's own width (container query), so a
 * large iOS text size never pushes it off screen (AX-02); at the default size
 * it is the plain 40 px token. The "..." menu comes after the title in the
 * DOM, so VoiceOver reads the title first (AX-12, R5); it is still drawn in
 * the top-right corner.
 */
export function DetailHero({ amount, amountTone = "default", title, meta, status, menu }: {
  amount?: ReactNode; amountTone?: keyof typeof TONE; title: string; meta?: ReactNode; status?: ReactNode; menu?: ReactNode;
}) {
  return (
    <div className="relative select-text px-2 pb-5 pt-2 text-center [container-type:inline-size]">
      {amount !== undefined ? (
        <p
          className={`text-[length:min(var(--text-hero),17cqi)] font-bold leading-tight tracking-[-0.02em] tabular-nums ${TONE[amountTone]}`}
        >
          {amount}
        </p>
      ) : null}
      <h1
        className={`${amount !== undefined ? "mt-1 text-headline" : "text-title-2"} font-semibold text-ink [overflow-wrap:anywhere]`}
      >
        {title}
      </h1>
      {meta ? <p className="mt-0.5 text-sm text-ink-2">{meta}</p> : null}
      {status ? <div className="mt-3 flex justify-center">{status}</div> : null}
      {menu ? <div className="absolute right-0 top-0">{menu}</div> : null}
    </div>
  );
}
