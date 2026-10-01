/**
 * The "Saatavat" bar on Myynti: money paid lately, money waiting and money late, from figures the
 * list API already computes. Pure, so the page stays a thin view and the wording is tested.
 */

/** How far back "Maksettu" looks. Ninety days is long enough to hold a quiet month and short enough to stay current. */
export const PAID_WINDOW_DAYS = 90;

/** The sales list filter each segment opens (same ids as SalesFilterId). */
export type ReceivablesSegmentKey = "paid" | "sent" | "overdue";

export interface ReceivablesSegment {
  key: ReceivablesSegmentKey;
  label: string;
  valueCents: number;
  tone: "success" | "neutral" | "danger";
}

/** Money received on invoices in the last `days` days (payment date, not invoice date). Never negative. */
export function paidWithinWindowCents(
  payments: ReadonlyArray<{ paidDate: Date | string; amountCents: number }>,
  now: Date = new Date(),
  days: number = PAID_WINDOW_DAYS
): number {
  const from = now.getTime() - days * 24 * 60 * 60 * 1000;
  let sum = 0;
  for (const payment of payments) {
    const at = new Date(payment.paidDate).getTime();
    if (Number.isFinite(at) && at >= from) sum += payment.amountCents;
  }
  return Math.max(0, sum);
}

/**
 * Segments in reading order: paid, waiting, late. `paidCents` may be missing (a list cached before
 * the field existed): then the paid part is left out instead of drawn as a false zero.
 */
export function receivablesSegments(input: {
  buckets: Record<string, { openCents: number } | undefined>;
  overdueCents: number;
  paidCents?: number | null;
}): ReceivablesSegment[] {
  const waiting = input.buckets["not_due"]?.openCents ?? 0;
  const segments: ReceivablesSegment[] = [];
  if (typeof input.paidCents === "number") {
    segments.push({ key: "paid", label: `Maksettu ${PAID_WINDOW_DAYS} pv`, valueCents: input.paidCents, tone: "success" });
  }
  segments.push({ key: "sent", label: "Odottaa maksua", valueCents: waiting, tone: "neutral" });
  segments.push({ key: "overdue", label: "Myöhässä", valueCents: input.overdueCents, tone: "danger" });
  return segments;
}
