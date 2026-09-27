/** Links from a report figure to the rows that compose it. */

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function receiptDrillHref(filter: {
  month?: string | null;
  type?: string | null;
  category?: string | null;
}): string {
  const params = new URLSearchParams();
  if (filter.month && MONTH.test(filter.month)) params.set("month", filter.month);
  if (filter.type === "tulo" || filter.type === "meno") params.set("type", filter.type);
  if (filter.category && filter.category !== "Luokittelematon") {
    params.set("category", filter.category);
  }
  const query = params.toString();
  return query ? `/kuitit?${query}` : "/kuitit";
}

export function statementDrillHref(month: string): string {
  return MONTH.test(month) ? `/pankki/tapahtumat?month=${month}` : "/pankki/tapahtumat";
}

export function invoiceDrillHref(filter: { month?: string | null; status?: string | null }): string {
  const params = new URLSearchParams();
  if (filter.month && MONTH.test(filter.month)) params.set("month", filter.month);
  if (
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

export function alvDrillHref(period: string): string {
  return `/kirjanpito/alv?period=${encodeURIComponent(period)}`;
}

export interface DrillFilters {
  month?: string;
  type?: "tulo" | "meno";
  category?: string;
  status?: string;
}

export function drillFromSearch(search: string): DrillFilters {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const month = params.get("month") || "";
  const type = params.get("type");
  const category = params.get("category") || "";
  const status = params.get("status") || "";
  const filters: DrillFilters = {};
  if (MONTH.test(month)) filters.month = month;
  if (type === "tulo" || type === "meno") filters.type = type;
  if (category) filters.category = category.slice(0, 100);
  if (status) filters.status = status;
  return filters;
}
