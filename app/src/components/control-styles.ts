/** Shared control chrome. Selected and idle chips both read as pressable. */

export const controlClass =
  "box-border block w-full min-w-0 max-w-full px-3 rounded-xl border border-warm-gray-light/60 bg-white text-sm";

const CHIP_BASE =
  "active-press inline-flex min-h-12 shrink-0 items-center justify-center rounded-full border px-4 text-sm font-medium transition-colors";

export function chipClass(selected: boolean): string {
  return selected
    ? `${CHIP_BASE} border-charcoal bg-charcoal text-white shadow-sm`
    : `${CHIP_BASE} border-warm-gray-light bg-white text-charcoal hover:bg-cream`;
}

export const BUTTON_VARIANTS = {
  primary: "bg-accent text-white hover:bg-accent-dark",
  secondary: "bg-white text-charcoal border border-warm-gray-light/70 hover:bg-cream",
  danger: "bg-white text-danger border border-danger/30 hover:bg-danger/5",
  ghost: "bg-transparent text-charcoal border border-transparent hover:bg-cream",
} as const;

export type ButtonVariant = keyof typeof BUTTON_VARIANTS;

export function buttonClass(variant: ButtonVariant = "primary", extra = ""): string {
  return `active-press inline-flex min-h-12 items-center justify-center gap-2 rounded-xl px-4 text-sm font-medium transition-colors disabled:opacity-60 ${BUTTON_VARIANTS[variant]} ${extra}`;
}
