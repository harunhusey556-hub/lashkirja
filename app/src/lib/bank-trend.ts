/**
 * The small balance line on a bank account row: the last months' closing balances and one
 * sentence for VoiceOver. Pure, so the rule "no line under three points" lives in one place.
 */

export const TREND_MAX_MONTHS = 6;
export const TREND_MIN_POINTS = 3;

/** Closing balances (euros) of the last `max` months, oldest first; empty when there are too few to draw a trend. */
export function balanceTrendPoints(
  closings: ReadonlyArray<number>,
  max: number = TREND_MAX_MONTHS
): number[] {
  const last = closings.filter((value) => Number.isFinite(value)).slice(-max);
  return last.length >= TREND_MIN_POINTS ? last : [];
}

/** "6 kk saldo": the name follows the real number of months drawn. */
export function trendCaption(points: number): string {
  return `${points} kk saldo`;
}

/** "Saldo 6 kuukauden ajalta: nousi 1 200,00 €." (the amount is only named for euro accounts). */
export function trendAriaLabel(points: ReadonlyArray<number>, currency: string, formatAmount: (value: number) => string): string {
  const first = points[0];
  const last = points[points.length - 1];
  const change = Math.round((last - first) * 100) / 100;
  const span = `Saldo ${points.length} kuukauden ajalta`;
  if (change === 0) return `${span}: pysyi ennallaan.`;
  const word = change > 0 ? "nousi" : "laski";
  return currency === "EUR" ? `${span}: ${word} ${formatAmount(Math.abs(change))}.` : `${span}: ${word}.`;
}
