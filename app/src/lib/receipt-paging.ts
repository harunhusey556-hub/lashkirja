import type { ReceiptListPayload } from "@/lib/receipt-list";

/** One page of the Kuitit list. Small, so the first rows paint before the rest is even asked for. */
export const RECEIPT_PAGE_SIZE = 50;

/** The Kuitit list's query before any filter is applied (its key in the page cache is `receipts:<this>`). */
export const DEFAULT_RECEIPT_QUERY = "sort=date_desc&kind=receipt";
/** The chip counts' query before any filter is applied. */
export const DEFAULT_RECEIPT_COUNTS_QUERY = "kind=receipt";

/** What the server said about a page; both paging styles are read (cursor, and the older offset+truncated). */
export interface ReceiptPageResponse<T> {
  receipts?: T[];
  count?: number;
  /** The paged answer's count of the whole filtered list. */
  total?: number;
  truncated?: boolean;
  nextCursor?: string | null;
}

/** The query string of a list request: the screen's own filters plus the page size. */
export function receiptPageQuery(
  query: string,
  next: { cursor?: string | null; offset?: number } = {}
): string {
  const params = new URLSearchParams(query);
  const sort = params.get("sort");
  // The server pages by cursor only newest-first and answers 400 to `limit`
  // with any other sort, so those keep the older offset pages.
  if (sort && sort !== "date_desc") {
    if (next.offset) params.set("offset", String(next.offset));
    return params.toString();
  }
  params.set("limit", String(RECEIPT_PAGE_SIZE));
  if (next.cursor) params.set("cursor", next.cursor);
  else if (next.offset) params.set("offset", String(next.offset));
  return params.toString();
}

/** How to ask for the page after `list`: its cursor when the server gave one, else the row offset. */
export function nextPageParams<T>(list: ReceiptListPayload<T>): { cursor?: string | null; offset?: number } {
  return list.nextCursor ? { cursor: list.nextCursor } : { offset: list.receipts.length };
}

/** A server answer as a list; `truncated` is true whenever another page exists. */
export function readReceiptPage<T>(data: ReceiptPageResponse<T>): ReceiptListPayload<T> {
  const receipts = data.receipts ?? [];
  const nextCursor = data.nextCursor ?? null;
  return {
    receipts,
    count: typeof data.count === "number" ? data.count : typeof data.total === "number" ? data.total : receipts.length,
    truncated: nextCursor !== null || Boolean(data.truncated),
    nextCursor,
  };
}

/**
 * The next page appended to what is already shown. A row that moved between
 * pages while the owner scrolled (a sync inserted a newer receipt) is kept
 * once, at its first place, never twice.
 */
export function appendReceiptPage<T extends { id: string }>(
  current: ReceiptListPayload<T>,
  page: ReceiptListPayload<T>
): ReceiptListPayload<T> {
  const seen = new Set(current.receipts.map((item) => item.id));
  const fresh = page.receipts.filter((item) => !seen.has(item.id));
  return {
    receipts: fresh.length === 0 ? current.receipts : [...current.receipts, ...fresh],
    count: page.count,
    truncated: page.truncated,
    nextCursor: page.nextCursor ?? null,
  };
}

/**
 * A reload keeps every row object that did not change, so a memoised row does
 * not repaint when the list is refetched after a sync (same idea as the bank
 * feed's `reuseEqualRows`). Rows are compared by their JSON, which is cheap at
 * page size and only runs on a fetched page.
 */
export function reuseEqualReceipts<T extends { id: string }>(previous: T[], next: T[]): T[] {
  if (previous.length === 0) return next;
  const byId = new Map(previous.map((item) => [item.id, item]));
  let same = previous.length === next.length;
  const merged = next.map((item, index) => {
    const old = byId.get(item.id);
    const kept = old && JSON.stringify(old) === JSON.stringify(item) ? old : item;
    if (same && previous[index] !== kept) same = false;
    return kept;
  });
  return same ? previous : merged;
}
