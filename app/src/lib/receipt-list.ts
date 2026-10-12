export interface ReceiptListPayload<T> {
  receipts: T[];
  count: number;
  truncated: boolean;
  /** Set when the server pages by cursor; absent for the older offset answer. */
  nextCursor?: string | null;
}

/** Accepts the current cache shape and the older array-only cache. */
export function coerceReceiptListCache<T>(raw: unknown): ReceiptListPayload<T> | null {
  if (Array.isArray(raw)) {
    return { receipts: raw as T[], count: raw.length, truncated: false };
  }
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<ReceiptListPayload<T>>;
  if (!Array.isArray(value.receipts) || typeof value.count !== "number") return null;
  return {
    receipts: value.receipts,
    count: value.count,
    truncated: Boolean(value.truncated),
    nextCursor: typeof value.nextCursor === "string" ? value.nextCursor : null,
  };
}

export function mergeReceiptPage<T>(
  current: T[],
  page: ReceiptListPayload<T>,
  offset: number
): ReceiptListPayload<T> {
  return {
    receipts: offset > 0 ? [...current, ...page.receipts] : [...page.receipts],
    count: page.count,
    truncated: page.truncated,
  };
}

export function dropReceipt<T extends { id: string }>(
  list: ReceiptListPayload<T>,
  id: string
): ReceiptListPayload<T> {
  const receipts = list.receipts.filter((item) => item.id !== id);
  const removed = list.receipts.length - receipts.length;
  const count = Math.max(0, list.count - removed);
  return { receipts, count, truncated: count > receipts.length, nextCursor: list.nextCursor };
}

export function dropReceipts<T extends { id: string }>(
  list: ReceiptListPayload<T>,
  ids: ReadonlySet<string>
): ReceiptListPayload<T> {
  const receipts = list.receipts.filter((item) => !ids.has(item.id));
  const removed = list.receipts.length - receipts.length;
  const count = Math.max(0, list.count - removed);
  return { receipts, count, truncated: count > receipts.length, nextCursor: list.nextCursor };
}

export function receiptCountLabel(count: number, filtered: boolean): string {
  const noun = count === 1 ? "kuitti" : "kuittia";
  return `${count} ${noun}${filtered ? " (suodatettu)" : ""}`;
}
