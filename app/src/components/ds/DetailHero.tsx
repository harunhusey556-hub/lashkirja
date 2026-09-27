import type { ReactNode } from "react";

const TONE = { default: "text-ink", positive: "text-success", negative: "text-ink" } as const;

export function DetailHero({ amount, amountTone = "default", title, meta, status, menu }: {
  amount?: ReactNode; amountTone?: keyof typeof TONE; title: string; meta?: ReactNode; status?: ReactNode; menu?: ReactNode;
}) {
  return (
    <div className="relative select-text px-2 pb-5 pt-2 text-center">
      {menu ? <div className="absolute right-0 top-0">{menu}</div> : null}
      {amount !== undefined ? (
        <p className={`text-[40px] font-bold leading-tight tracking-[-0.02em] tabular-nums ${TONE[amountTone]}`}>{amount}</p>
      ) : null}
      <h1 className={`${amount !== undefined ? "mt-1 text-[17px]" : "text-[28px]"} font-semibold text-ink`}>{title}</h1>
      {meta ? <p className="mt-0.5 text-sm text-ink-2">{meta}</p> : null}
      {status ? <div className="mt-3 flex justify-center">{status}</div> : null}
    </div>
  );
}
