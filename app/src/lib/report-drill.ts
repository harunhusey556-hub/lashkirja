/** Links from a report figure to the rows that compose it. */

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
/** A month, or a whole year for the year-level figures. */
const PERIOD = /^\d{4}(-(0[1-9]|1[0-2]))?$/;

export function receiptDrillHref(filter: {
  month?: string | null;
  type?: string | null;
  category?: string | null;
}): string {
  const params = new URLSearchParams();
  if (filter.month && PERIOD.test(filter.month)) params.set("month", filter.month);
  if (filter.type === "tulo" || filter.type === "meno") params.set("type", filter.type);
  if (filter.category && filter.category !== "Luokittelematon") {
    params.set("category", filter.category);
  }
  // A figure counts the bills filed as ostolaskut too, so its list asks for every document, not
  // Kuitit's own kind=receipt (X079, as the phone's ReceiptListQuery.drill).
  params.set("drill", "1");
  return `/kuitit?${params.toString()}`;
}

export function statementDrillHref(month: string): string {
  return MONTH.test(month) ? `/pankki/tapahtumat?month=${month}` : "/pankki/tapahtumat";
}

export function invoiceDrillHref(filter: { month?: string | null; status?: string | null }): string {
  const params = new URLSearchParams();
  if (filter.month && PERIOD.test(filter.month)) params.set("month", filter.month);
  if (
    filter.status === "all" ||
    filter.status === "credited" ||
    filter.status === "draft" ||
    filter.status === "sent" ||
    filter.status === "paid" ||
    filter.status === "overdue"
  ) {
    params.set("status", filter.status);
  }
  const query = params.toString();
  return query ? `/laskut?${query}` : "/laskut";
}

/** Category rows the profit and loss puts sales invoices and credit notes in (lib/reports.ts). */
const INVOICE_CATEGORIES = new Set(["Myyntilaskut", "Hyvityslaskut"]);

export interface DrillTarget {
  id: "invoices" | "income-receipts" | "expense-receipts" | "purchase-invoices";
  /** Short visible label of the destination. */
  label: string;
  href: string;
  /** What the link opens, named for a screen reader. */
  ariaLabel: string;
}

interface DrillPeriod {
  month?: string | null;
  invoiceCount?: number;
  creditNoteCount?: number;
  /** Purchase invoices counted in the expenses; they are not receipts, so Kuitit does not list them. */
  purchaseInvoiceCount?: number;
  incomeByCategory?: Array<{ category: string; count: number }>;
  expenseByCategory?: Array<{ category: string; count: number }>;
}

function sumCounts(rows: Array<{ count: number }>): number {
  return rows.reduce((sum, row) => sum + row.count, 0);
}

/**
 * Where a report income figure lives (F71). Sales invoices and credit notes
 * are not receipts, so the receipts list never contains them: the invoice
 * list is one destination, cash-sale receipts the other. A destination is
 * offered only when it holds rows for the period, so a figure can never open
 * a list that claims to be empty.
 */
export function incomeDrillTargets(period: DrillPeriod): DrillTarget[] {
  const rows = period.incomeByCategory ?? [];
  const invoiceRows = sumCounts(rows.filter((row) => INVOICE_CATEGORIES.has(row.category)));
  const invoiceDocuments = Math.max((period.invoiceCount ?? 0) + (period.creditNoteCount ?? 0), invoiceRows);
  const receiptRows = sumCounts(rows.filter((row) => !INVOICE_CATEGORIES.has(row.category)));
  const targets: DrillTarget[] = [];
  if (invoiceDocuments > 0) {
    targets.push({
      id: "invoices",
      label: "Laskut",
      href: invoiceDrillHref({ month: period.month, status: "all" }),
      ariaLabel: "Avaa myyntilaskut",
    });
  }
  if (receiptRows > 0) {
    targets.push({
      id: "income-receipts",
      label: "Tulokuitit",
      href: receiptDrillHref({ month: period.month, type: "tulo" }),
      ariaLabel: "Avaa tulokuitit",
    });
  }
  return targets;
}

/** The expense receipts: every expense row that is not a purchase invoice. */
export function expenseDrillTarget(period: DrillPeriod): DrillTarget | null {
  if (sumCounts(period.expenseByCategory ?? []) - (period.purchaseInvoiceCount ?? 0) <= 0) return null;
  return {
    id: "expense-receipts",
    label: "Menokuitit",
    href: receiptDrillHref({ month: period.month, type: "meno" }),
    ariaLabel: "Avaa menokuitit",
  };
}

/** Purchase invoices no receipt documents (rent, a typed-in bill) have their own list. */
export function purchaseInvoiceDrillTarget(period: DrillPeriod): DrillTarget | null {
  if ((period.purchaseInvoiceCount ?? 0) <= 0) return null;
  return {
    id: "purchase-invoices",
    label: "Ostolaskut",
    href: "/kirjanpito/ostolaskut",
    ariaLabel: "Avaa ostolaskut",
  };
}

/** Where a report expense figure lives: the receipts and the purchase invoices, whichever hold rows for it. */
export function expenseDrillTargets(period: DrillPeriod): DrillTarget[] {
  return [expenseDrillTarget(period), purchaseInvoiceDrillTarget(period)].filter((target): target is DrillTarget => target !== null);
}

export function alvDrillHref(period: string): string {
  return `/kirjanpito/alv?period=${encodeURIComponent(period)}`;
}

export interface DrillFilters {
  month?: string;
  type?: "tulo" | "meno";
  category?: string;
  status?: string;
  /** Opened from a figure: the list holds every document it counts (`receiptKindParam`). */
  drill?: boolean;
}

export function drillFromSearch(search: string): DrillFilters {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const month = params.get("month") || "";
  const type = params.get("type");
  const category = params.get("category") || "";
  const status = params.get("status") || "";
  const filters: DrillFilters = {};
  if (PERIOD.test(month)) filters.month = month;
  if (type === "tulo" || type === "meno") filters.type = type;
  if (category) filters.category = category.slice(0, 100);
  if (status) filters.status = status;
  if (params.get("drill") === "1") filters.drill = true;
  return filters;
}
