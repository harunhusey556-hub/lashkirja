/**
 * Purchase invoice list grouping and filter-chip counting - pure functions,
 * no React or fetch here, mirroring ./invoice-groups (the sales-invoice
 * equivalent) so /kirjanpito/ostolaskut can stay a thin view over this.
 */
import type { PurchaseStatus } from "./purchase-invoices";

/** Minimal invoice shape this module needs. */
export interface StatusedPurchaseInvoice {
  displayStatus: PurchaseStatus | "overdue";
}

/** Every filter id the purchase list supports: "all" plus one per display status. */
export const PURCHASE_FILTER_IDS = ["all", "overdue", "open", "paid", "cancelled"] as const;
export type PurchaseFilterId = (typeof PURCHASE_FILTER_IDS)[number];

type PurchaseStatusFilterId = Exclude<PurchaseFilterId, "all">;

/**
 * The server's per-fetch row cap (see `listPurchaseInvoices` in
 * ./purchase-invoices, which caps `take` at this value).
 */
export const PURCHASE_LIST_LIMIT = 200;

/**
 * Fixed display order for both the "Kaikki" section groups and the filter
 * chips: overdue first (most urgent), cancelled last (and hidden entirely
 * from the chips when there are none - see `purchaseFilterChips`).
 */
const STATUS_ORDER: PurchaseStatusFilterId[] = ["overdue", "open", "paid", "cancelled"];

const FILTER_LABEL: Record<PurchaseFilterId, string> = {
  all: "Kaikki",
  overdue: "Myöhässä",
  open: "Avoimet",
  paid: "Maksetut",
  cancelled: "Mitätöidyt",
};

const GROUP_LABEL: Record<PurchaseStatusFilterId, string> = {
  overdue: "Myöhässä",
  open: "Avoimet",
  paid: "Maksetut",
  cancelled: "Mitätöidyt",
};

export interface PurchaseFilterChip {
  id: PurchaseFilterId;
  label: string;
  count: number;
}

export interface PurchaseInvoiceGroup<T> {
  id: PurchaseStatusFilterId;
  label: string;
  items: T[];
}

/**
 * Counts per display status, keyed the same as the filter/group ids. These
 * come from the database (`countPurchaseInvoicesByDisplayStatus` in
 * ./purchase-invoices) rather than from the fetched rows: the row list is
 * capped at `PURCHASE_LIST_LIMIT`, so counting the rows themselves would
 * silently undercount past that cap.
 */
export type PurchaseStatusCounts = Record<PurchaseStatusFilterId, number>;

/**
 * Chips for `FilterChips`: "Kaikki" plus one per status, in a fixed order,
 * with live counts. "Mitätöidyt" only appears once at least one invoice has
 * actually been cancelled - an always-zero cancelled filter is dead weight.
 */
export function purchaseFilterChips(counts: PurchaseStatusCounts): PurchaseFilterChip[] {
  const total = STATUS_ORDER.reduce((sum, id) => sum + counts[id], 0);
  const chips: PurchaseFilterChip[] = [{ id: "all", label: FILTER_LABEL.all, count: total }];
  for (const id of STATUS_ORDER) {
    if (id === "cancelled" && counts.cancelled === 0) continue;
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
export function purchaseInvoiceGroups<T extends StatusedPurchaseInvoice>(
  invoices: readonly T[],
  filter: PurchaseFilterId
): PurchaseInvoiceGroup<T>[] {
  if (filter === "all") {
    return STATUS_ORDER.map((id) => ({
      id,
      label: GROUP_LABEL[id],
      items: invoices.filter((invoice) => invoice.displayStatus === id),
    })).filter((group) => group.items.length > 0);
  }
  const items = invoices.filter((invoice) => invoice.displayStatus === filter);
  return items.length > 0 ? [{ id: filter, label: GROUP_LABEL[filter], items }] : [];
}
