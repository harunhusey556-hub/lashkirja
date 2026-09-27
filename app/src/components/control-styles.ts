/** Shared control chrome. Selected and idle chips both read as pressable. */

export const controlClass =
  "box-border block w-full min-w-0 max-w-full px-3 min-h-12 rounded-card border border-line bg-surface text-[16px] text-ink";

const CHIP_BASE =
  "ds-chip active-press inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium";

export function chipClass(selected: boolean): string {
  return selected
    ? `${CHIP_BASE} border-ink bg-ink text-canvas`
    : `${CHIP_BASE} border-line bg-surface text-ink`;
}

export const BUTTON_VARIANTS = {
  primary: "bg-ink text-canvas",
  secondary: "bg-surface text-ink border border-line",
  danger: "bg-surface text-danger border border-danger/30",
  ghost: "bg-transparent text-accent",
} as const;

export type ButtonVariant = keyof typeof BUTTON_VARIANTS;

export function buttonClass(variant: ButtonVariant = "primary", extra = ""): string {
  return `active-press inline-flex min-h-12 items-center justify-center gap-2 rounded-card px-4 text-[15px] font-semibold disabled:opacity-60 ${BUTTON_VARIANTS[variant]} ${extra}`;
}
