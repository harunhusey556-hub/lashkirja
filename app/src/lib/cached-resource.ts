import { readPageCache, writePageCache } from "@/lib/page-cache";

/**
 * The pure part of `useCachedResource` (N3): which copy of a value a screen
 * paints, and how a refresh treats the cache. Kept free of React so the rules
 * are unit-tested.
 */
export interface FetchedValue<T> {
  key: string;
  value: T;
}

/**
 * What the screen shows, in order: the value the refresh just fetched for this
 * key, then the page-cache copy (memory, or hydrated from the persistent
 * cache), then the copy that only became readable after the mobile boot
 * hydrated the cache. `null` means "nothing known yet": the caller shows a
 * skeleton, never a zero or an empty value.
 */
export function pickCachedValue<T>(
  key: string | null,
  fetched: FetchedValue<T> | null,
  cached: T | null,
  lateCached: T | null
): T | null {
  if (!key) return null;
  if (fetched && fetched.key === key) return fetched.value;
  return cached ?? lateCached ?? null;
}

export type RefreshResult<T> = { ok: true; value: T } | { ok: false; error: unknown };

/**
 * One quiet refresh. A success is written through to the page cache (which
 * mirrors it to the persistent cache on mobile); a failure leaves whatever is
 * cached untouched, so a failed refresh keeps the last known value.
 */
export async function refreshCached<T>(
  key: string,
  load: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal
): Promise<RefreshResult<T>> {
  try {
    const value = await load(signal);
    if (!signal.aborted) writePageCache(key, value);
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error };
  }
}

/** Write a locally-known new value (after a save) so the next visit paints it too. */
export function storeCached<T>(key: string, value: T): void {
  writePageCache(key, value);
}

export function readCached<T>(key: string | null): T | null {
  return key ? readPageCache<T>(key) : null;
}

/** Page-cache keys shared by a hub row and the screen behind it. */
export const PURCHASE_COUNTS_KEY = "purchase-counts";
export const PERIOD_LOCK_KEY = "period-lock";
export const BANK_ACCOUNT_COUNT_KEY = "bank-account-count";
export const alvSummaryKey = (period: string) => `alv-summary:${period}`;
export const CUSTOMER_COUNT_KEY = "customer-count";
export const RECURRING_COUNT_KEY = "recurring-count";
export const UNMATCHED_KEY = "unmatched";
