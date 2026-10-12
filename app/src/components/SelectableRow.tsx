import type { ReactNode } from "react";
import { Check } from "lucide-react";

/**
 * A list row with the round select checkbox on its left, the same control as
 * the Kuitit rows (ReceiptRow). Used by the select modes of Pankki and
 * Ostolaskut; the row itself decides what a tap on its body does.
 */
export function SelectableRow({
  selected,
  onToggle,
  label,
  children,
}: {
  selected: boolean;
  onToggle: () => void;
  /** Spoken name of the checkbox, e.g. "Valitse Kahvila Oy". */
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-stretch">
      <label className="relative flex w-11 shrink-0 cursor-pointer items-center justify-center">
        {/* Fills the cell instead of sr-only, so a tap lands on the input itself and not on the drawn circle above it. */}
        <input type="checkbox" className="peer absolute inset-0 h-full w-full cursor-pointer opacity-0" checked={selected} onChange={onToggle} aria-label={label} />
        <span className="pointer-events-none flex h-5 w-5 items-center justify-center rounded-full border-[1.5px] border-ink-2/50 bg-surface transition-colors peer-checked:border-ink peer-checked:bg-ink peer-focus-visible:ring-2 peer-focus-visible:ring-accent/40">
          <Check
            aria-hidden
            width={12}
            height={12}
            strokeWidth={3.5}
            className={`text-canvas transition-opacity ${selected ? "opacity-100" : "opacity-0"}`}
          />
        </span>
      </label>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** `SelectableRow` while a list is in select mode, the bare row otherwise. */
export function SelectableRowIf({
  on,
  ...props
}: {
  on: boolean;
  selected: boolean;
  onToggle: () => void;
  label: string;
  children: ReactNode;
}) {
  return on ? <SelectableRow {...props} /> : <>{props.children}</>;
}
