/**
 * Sales invoice list grouping and filter-chip counting - pure functions, no
 * React or fetch here so the /laskut page can stay a thin view over this.
 */
import type { InvoiceDisplayStatus } from "./invoices";

/** Minimal invoice shape this module needs. */
export interface StatusedInvoice {
  displayStatus: InvoiceDisplayStatus;
  /** A credit note is grouped with the credited invoices, never as an open one. */
  documentKind?: "invoice" | "credit_note";
}

/** The list group (and filter) an invoice belongs to. */
export function invoiceGroupId(invoice: StatusedInvoice): StatusFilterId {
  return invoice.documentKind === "credit_note" ? "credited" : invoice.displayStatus;
}

/** Every filter id the sales list supports: "all" plus one per display status. */
export const SALES_FILTER_IDS = ["all", "overdue", "draft", "sent", "paid", "credited"] as const;
export type SalesFilterId = (typeof SALES_FILTER_IDS)[number];

type StatusFilterId = Exclude<SalesFilterId, "all">;

/**
 * The server's per-fetch row cap (see `listInvoices` in ./sales-invoices,
 * which caps `take` at this value). Shared so the page's "showing the newest
 * N" note always names the actual limit rather than a copy of the number.
 */
export const INVOICE_LIST_LIMIT = 200;

/**
 * Fixed display order for both the "Kaikki" section groups and the filter
 * chips: overdue first (most urgent), credited last (and hidden entirely
 * from the chips when there are none - see `salesFilterChips`).
 */
const STATUS_ORDER: StatusFilterId[] = ["overdue", "draft", "sent", "paid", "credited"];

/** Chip wording. "sent" reads "Avoimet" here, distinct from its group heading below. */
const FILTER_LABEL: Record<SalesFilterId, string> = {
  all: "Kaikki",
  overdue: "Myöhässä",
  draft: "Luonnokset",
  sent: "Avoimet",
  paid: "Maksetut",
  credited: "Hyvitetyt",
};

/** Section heading wording for the "Kaikki" grouped view. */
const GROUP_LABEL: Record<StatusFilterId, string> = {
  overdue: "Myöhässä",
  draft: "Luonnokset",
  sent: "Odottaa maksua",
  paid: "Maksetut",
  credited: "Hyvitetyt",
};

export interface SalesFilterChip {
  id: SalesFilterId;
  label: string;
  count: number;
}

export interface SalesInvoiceGroup<T> {
  id: StatusFilterId;
  label: string;
  items: T[];
}

/**
 * Counts per display status, keyed the same as the filter/group ids. These
 * now come from the database (`countInvoicesByDisplayStatus` in
 * ./sales-invoices) rather than from the fetched rows: the row list is
 * capped at `INVOICE_LIST_LIMIT`, so counting the rows themselves would
 * silently undercount past that cap.
 */
export type SalesStatusCounts = Record<StatusFilterId, number>;

/**
 * Chips for `FilterChips`: "Kaikki" plus one per status, in a fixed order,
 * with live counts. "Hyvitetyt" only appears once at least one invoice has
 * actually been credited - an always-zero credit-note filter is dead weight.
 */
export function salesFilterChips(counts: SalesStatusCounts): SalesFilterChip[] {
  const total = STATUS_ORDER.reduce((sum, id) => sum + counts[id], 0);
  const chips: SalesFilterChip[] = [{ id: "all", label: FILTER_LABEL.all, count: total }];
  for (const id of STATUS_ORDER) {
    if (id === "credited" && counts.credited === 0) continue;
    chips.push({ id, label: FILTER_LABEL[id], count: counts[id] });
  }
  return chips;
}

/**
 * The Sections to render for the given filter:
 * - "all" groups every invoice by display status, in `STATUS_ORDER`, and
 *   drops any status with nothing in it.
 * - a specific status returns at most one group (empty when nothing matches,
 *   so the page can fall back to its empty state instead of an empty card).
 */
export function salesInvoiceGroups<T extends StatusedInvoice>(
  invoices: readonly T[],
  filter: SalesFilterId
): SalesInvoiceGroup<T>[] {
  if (filter === "all") {
    return STATUS_ORDER.map((id) => ({
      id,
      label: GROUP_LABEL[id],
      items: invoices.filter((invoice) => invoiceGroupId(invoice) === id),
    })).filter((group) => group.items.length > 0);
  }
  const items = invoices.filter((invoice) => invoiceGroupId(invoice) === filter);
  return items.length > 0 ? [{ id: filter, label: GROUP_LABEL[filter], items }] : [];
}
