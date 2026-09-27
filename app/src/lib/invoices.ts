/**
 * Sales invoice arithmetic and lifecycle - pure functions, integer cents.
 *
 * Quantities are thousandths (1000 = one unit) and VAT rates are permille
 * (255 = 25.5%) so nothing here depends on floating point. VAT is computed on
 * the summed net per rate rather than per line, which is how a Finnish invoice
 * total is stated and avoids per-line rounding drift.
 */

export const VAT_RATES_PERMILLE = [255, 140, 135, 100, 0] as const;
export type VatRatePermille = (typeof VAT_RATES_PERMILLE)[number];

export const DEFAULT_VAT_RATE_PERMILLE = 255;
export const DEFAULT_PAYMENT_TERM_DAYS = 14;
export const MAX_PAYMENT_TERM_DAYS = 365;

export interface InvoiceLineInput {
  description?: string;
  /** Thousandths of a unit; 1500 = 1.5. */
  quantityMilli: number;
  unitPriceCents: number;
  vatRatePermille: number;
}

export interface InvoiceLineTotals extends InvoiceLineInput {
  netCents: number;
}

export interface VatBreakdownRow {
  ratePermille: number;
  netCents: number;
  vatCents: number;
  grossCents: number;
}

export interface InvoiceTotals {
  lines: InvoiceLineTotals[];
  netCents: number;
  vatCents: number;
  grossCents: number;
  breakdown: VatBreakdownRow[];
}

/** Half away from zero, so -0.005 rounds to -0.01 like an invoice expects. */
export function roundHalfAwayFromZero(value: number): number {
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

export function isSupportedVatRate(ratePermille: number): boolean {
  return (VAT_RATES_PERMILLE as readonly number[]).includes(ratePermille);
}

export function vatForNet(netCents: number, ratePermille: number): number {
  return roundHalfAwayFromZero((netCents * ratePermille) / 1000);
}

export function lineNet(line: InvoiceLineInput): number {
  return roundHalfAwayFromZero((line.quantityMilli * line.unitPriceCents) / 1000);
}

export class InvoiceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvoiceValidationError";
  }
}

export function computeInvoiceTotals(lines: InvoiceLineInput[]): InvoiceTotals {
  if (lines.length === 0) {
    throw new InvoiceValidationError("Laskulla on oltava vähintään yksi rivi.");
  }

  const withNet: InvoiceLineTotals[] = lines.map((line) => {
    if (!Number.isSafeInteger(line.quantityMilli) || line.quantityMilli === 0) {
      throw new InvoiceValidationError("Rivin määrä puuttuu tai on virheellinen.");
    }
    if (!Number.isSafeInteger(line.unitPriceCents)) {
      throw new InvoiceValidationError("Rivin yksikköhinta on virheellinen.");
    }
    if (!isSupportedVatRate(line.vatRatePermille)) {
      throw new InvoiceValidationError(`Tuntematon ALV-kanta: ${line.vatRatePermille}.`);
    }
    return { ...line, netCents: lineNet(line) };
  });

  const netByRate = new Map<number, number>();
  for (const line of withNet) {
    netByRate.set(line.vatRatePermille, (netByRate.get(line.vatRatePermille) ?? 0) + line.netCents);
  }

  const breakdown: VatBreakdownRow[] = [...netByRate.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([ratePermille, netCents]) => {
      const vatCents = vatForNet(netCents, ratePermille);
      return { ratePermille, netCents, vatCents, grossCents: netCents + vatCents };
    });

  const netCents = breakdown.reduce((sum, row) => sum + row.netCents, 0);
  const vatCents = breakdown.reduce((sum, row) => sum + row.vatCents, 0);

  return { lines: withNet, netCents, vatCents, grossCents: netCents + vatCents, breakdown };
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

export type InvoiceStatus = "draft" | "sent" | "paid" | "credited";
/** What the user sees; "overdue" is derived from the date, never stored. */
export type InvoiceDisplayStatus = InvoiceStatus | "overdue";

export const INVOICE_STATUSES: InvoiceStatus[] = ["draft", "sent", "paid", "credited"];

const ALLOWED_TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  draft: ["sent", "credited"],
  // A sent invoice may go back to draft only before any payment is recorded;
  // the caller enforces that, the map allows it.
  sent: ["paid", "credited", "draft"],
  paid: ["credited", "sent"],
  credited: [],
};

export function canTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export function addDaysUtc(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

export function dueDateFor(issueDate: Date, termDays: number): Date {
  if (!Number.isInteger(termDays) || termDays < 0 || termDays > MAX_PAYMENT_TERM_DAYS) {
    throw new InvoiceValidationError("Maksuaika on 0-365 päivää.");
  }
  return addDaysUtc(issueDate, termDays);
}

export interface InvoiceLike {
  status: InvoiceStatus;
  dueDate: Date | string;
  documentKind?: string;
}

/**
 * UTC midnight of `now`'s calendar day.
 *
 * Due dates are stored as UTC midnights. An invoice is overdue once this
 * instant is strictly after the due day — the same boundary as displayStatus,
 * so a SQL `dueDate < overdueBefore(now)` matches the label the UI shows.
 */
export function overdueBefore(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** An unpaid sent invoice becomes overdue the day AFTER its due date. */
export function displayStatus(invoice: InvoiceLike, now: Date = new Date()): InvoiceDisplayStatus {
  if (invoice.documentKind === "credit_note") return invoice.status;
  if (invoice.status !== "sent") return invoice.status;
  const due = invoice.dueDate instanceof Date ? invoice.dueDate : new Date(invoice.dueDate);
  const dueEnd = Date.UTC(
    due.getUTCFullYear(),
    due.getUTCMonth(),
    due.getUTCDate(),
    23,
    59,
    59,
    999
  );
  return now.getTime() > dueEnd ? "overdue" : "sent";
}

export function daysOverdue(dueDate: Date | string, now: Date = new Date()): number {
  const due = dueDate instanceof Date ? dueDate : new Date(dueDate);
  const dueDay = Date.UTC(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate());
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const diff = Math.floor((today - dueDay) / 86_400_000);
  return diff > 0 ? diff : 0;
}

export type AgingBucket = "not_due" | "1-30" | "31-60" | "61-90" | "90+";

export const AGING_BUCKETS: AgingBucket[] = ["not_due", "1-30", "31-60", "61-90", "90+"];

export function agingBucket(dueDate: Date | string, now: Date = new Date()): AgingBucket {
  const days = daysOverdue(dueDate, now);
  if (days === 0) return "not_due";
  if (days <= 30) return "1-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "90+";
}

export interface ReceivableLike {
  status: InvoiceStatus;
  dueDate: Date | string;
  grossCents: number;
  paidCents?: number;
  closedReason?: string | null;
}

export interface OpenPositionInput {
  status: string;
  grossCents: number;
  paidCents?: number;
  closedReason?: string | null;
}

export interface OpenPosition {
  /** Cents still owed. Zero when written off, negative when overpaid. */
  openCents: number;
  /** True when this row belongs in collections and aging. */
  collectible: boolean;
  settled: boolean;
}

const NOT_A_RECEIVABLE = new Set(["draft", "credited", "cancelled"]);

/**
 * Status, collections, and the open balance all read this.
 *
 * An invoice is settled when payments cover it, or when an explicit close
 * recorded a reason. A stored "paid" flag with neither does not hide the
 * remainder: it stays collectible.
 */
export function openPosition(input: OpenPositionInput): OpenPosition {
  const paid = input.paidCents ?? 0;
  const remainder = input.grossCents - paid;
  const writtenOff = Boolean(input.closedReason?.trim());

  if (NOT_A_RECEIVABLE.has(input.status)) {
    return {
      openCents: input.status === "draft" ? remainder : Math.min(remainder, 0),
      collectible: false,
      settled: input.status !== "draft",
    };
  }

  if (writtenOff) {
    return { openCents: 0, collectible: false, settled: true };
  }

  if (remainder <= 0) {
    return { openCents: remainder, collectible: false, settled: true };
  }

  return { openCents: remainder, collectible: true, settled: false };
}

export interface AgingReport {
  buckets: Record<AgingBucket, { count: number; openCents: number }>;
  totalOpenCents: number;
  overdueCents: number;
  overdueCount: number;
}

export interface AgingItem {
  dueDate: Date | string;
  openCents: number;
}

/**
 * Aging over anything with a due date and an open amount. Receivables and
 * payables age identically; only what counts as "open" differs, and that
 * decision belongs to the caller.
 */
export function buildAging(items: AgingItem[], now: Date = new Date()): AgingReport {
  const buckets = Object.fromEntries(
    AGING_BUCKETS.map((bucket) => [bucket, { count: 0, openCents: 0 }])
  ) as AgingReport["buckets"];

  let totalOpenCents = 0;
  let overdueCents = 0;
  let overdueCount = 0;

  for (const item of items) {
    if (item.openCents <= 0) continue;
    const bucket = agingBucket(item.dueDate, now);
    buckets[bucket].count += 1;
    buckets[bucket].openCents += item.openCents;
    totalOpenCents += item.openCents;
    if (bucket !== "not_due") {
      overdueCents += item.openCents;
      overdueCount += 1;
    }
  }

  return { buckets, totalOpenCents, overdueCents, overdueCount };
}

/** Accounts receivable aging over the invoices that are actually outstanding. */
export function buildAgingReport(
  invoices: ReceivableLike[],
  now: Date = new Date()
): AgingReport {
  return buildAging(
    invoices.map((invoice) => {
      const position = openPosition({
        status: invoice.status,
        grossCents: invoice.grossCents,
        paidCents: invoice.paidCents,
        closedReason: invoice.closedReason,
      });
      return {
        dueDate: invoice.dueDate,
        openCents: position.collectible ? position.openCents : 0,
      };
    }),
    now
  );
}
