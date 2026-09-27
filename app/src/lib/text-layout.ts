/** Shared wrapping so a long name, IBAN, or amount does not paint over its neighbour. */
export const longNameClass = "min-w-0 truncate";
export const longIbanClass = "min-w-0 break-all text-right";
export const amountClass = "shrink-0 whitespace-nowrap tabular-nums";
export const finnishLabelClass = "min-w-0 break-words";

/** Matches the date-row stack in globals.css. */
export const DATE_STACK_MAX_PX = 480;

export function dateRowStacks(width: number): boolean {
  return width <= DATE_STACK_MAX_PX;
}

/**
 * Rough width of a string at the phone control size (16px) times the user's
 * text scale. Used only to decide that a huge amount should stay nowrap and
 * the name should truncate, not to measure the DOM.
 */
export function estimatedTextPx(text: string, fontScale: number): number {
  const scale = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  return Math.ceil(text.length * 9 * scale);
}

export function amountFitsBesideName(
  viewportWidth: number,
  horizontalPadding: number,
  amount: string,
  fontScale: number
): boolean {
  const row = viewportWidth - horizontalPadding;
  const amountPx = estimatedTextPx(amount, fontScale);
  return amountPx <= row * 0.55 && row - amountPx >= 96;
}
