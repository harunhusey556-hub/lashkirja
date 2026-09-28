import type { CacheRecord, PersistentCache } from "@/lib/offline/persistent-cache";

/**
 * Last-seen payload per screen, kept in memory for the tab's lifetime.
 *
 * Navigating back to a list should show that list, not a spinner over an empty
 * page. The cached copy is painted immediately and replaced as soon as the
 * fetch that always follows returns. `fetchedAt` lets the screen say when that
 * copy was last successful, so a failed refresh is not painted as fresh.
 *
 * Web: deliberately not persisted -- bookkeeping data has no business
 * surviving in storage after the tab is closed. Mobile (Task 7): the app
 * itself is the only place this data lives, so `configurePageCachePersistence`
 * wires in the encrypted persistent cache with a much longer TTL and a
 * write-through -- every value here is mirrored under "page:<key>" there,
 * fire and forget, so a relaunch can paint the last copy before the network
 * catches up (`hydratePageCache`, called once at boot).
 */
/** A copy older than this is treated as missing. The screen refetches. */
export const PAGE_CACHE_TTL_MS = 5 * 60 * 1000;
/** Bound the in-memory map so a long session cannot keep every list forever. */
export const PAGE_CACHE_MAX_ENTRIES = 40;

const cache = new Map<string, unknown>();
const fetchedAt = new Map<string, number>();

let ttlMs: number = PAGE_CACHE_TTL_MS;
let maxEntries: number = PAGE_CACHE_MAX_ENTRIES;
let persistentStore: PersistentCache | null = null;

function persistentKey(key: string): string {
  return `page:${key}`;
}

/**
 * Mobile only (Task 7 rule: never called on the web -- every web path
 * stays memory-only with the 5 min TTL/40-entry defaults above). `null`
 * clears any previous store and restores the web defaults.
 */
export function configurePageCachePersistence(
  store: PersistentCache | null,
  nextTtlMs: number = PAGE_CACHE_TTL_MS,
  nextMaxEntries: number = PAGE_CACHE_MAX_ENTRIES
): void {
  persistentStore = store;
  ttlMs = store ? nextTtlMs : PAGE_CACHE_TTL_MS;
  maxEntries = store ? nextMaxEntries : PAGE_CACHE_MAX_ENTRIES;
}

/** Boot hydration: seeds the in-memory map from the persistent cache's
 * "page:" records, one call, before any screen has had a chance to write
 * its own value -- the "never overwrite" rule means a value already
 * present (a screen that mounted first) always wins. */
export function hydratePageCache(records: CacheRecord[]): void {
  for (const record of records) {
    if (!record.key.startsWith("page:")) continue;
    const key = record.key.slice("page:".length);
    if (cache.has(key)) continue;
    cache.set(key, record.value);
    fetchedAt.set(key, record.fetchedAt);
  }
  evictToLimit();
}

export function pageCacheSize(): number {
  return cache.size;
}

export function readPageCache<T>(key: string, now = Date.now()): T | null {
  const at = fetchedAt.get(key);
  if (at == null) return null;
  if (now - at > ttlMs) {
    dropKey(key);
    return null;
  }
  return (cache.get(key) as T | undefined) ?? null;
}

export function pageCacheFetchedAt(key: string): number | null {
  return fetchedAt.get(key) ?? null;
}

function evictToLimit(): void {
  while (cache.size > maxEntries) {
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [key, at] of fetchedAt) {
      if (at < oldest) {
        oldest = at;
        oldestKey = key;
      }
    }
    if (!oldestKey) break;
    dropKey(oldestKey);
  }
}

export function writePageCache<T>(key: string, value: T, at = Date.now()): void {
  cache.set(key, value);
  fetchedAt.set(key, at);
  evictToLimit();
  if (persistentStore) {
    void persistentStore.set(persistentKey(key), value, at).catch(() => {});
  }
}

function dropKey(key: string): void {
  cache.delete(key);
  fetchedAt.delete(key);
}

/** Called after a mutation when the next screen must not show a stale copy. */
export function clearPageCache(key?: string): void {
  if (key) {
    dropKey(key);
    if (persistentStore) void persistentStore.delete(persistentKey(key)).catch(() => {});
    return;
  }
  cache.clear();
  fetchedAt.clear();
  if (persistentStore) void persistentStore.deletePrefix("page:").catch(() => {});
}

export function clearPageCachePrefix(prefix: string): string[] {
  const removed: string[] = [];
  for (const key of cache.keys()) {
    if (key === prefix || key.startsWith(prefix)) {
      dropKey(key);
      removed.push(key);
    }
  }
  if (persistentStore) void persistentStore.deletePrefix(persistentKey(prefix)).catch(() => {});
  return removed;
}

/**
 * A write on one resource makes the related screens stale. Logout still
 * clears everything; this only drops the lists that would lie after the change.
 */
const MUTATION_PREFIXES: Array<{ match: (path: string) => boolean; prefixes: string[] }> = [
  {
    match: (path) => path.includes("/api/invoices") || path.includes("/api/recurring-invoices"),
    prefixes: ["invoices", "dashboard:", "report:", "alv:", "customers", "recurring"],
  },
  {
    match: (path) => path.includes("/api/purchase-invoices"),
    prefixes: ["purchases", "dashboard:", "report:", "alv:"],
  },
  {
    match: (path) => path.includes("/api/receipts") || path.includes("/api/matching"),
    prefixes: ["receipts", "jobs", "work-queue", "dashboard:", "report:", "alv:"],
  },
  {
    match: (path) => path.includes("/api/statements"),
    prefixes: ["statements", "bank-overview", "dashboard:", "report:"],
  },
  {
    match: (path) =>
      path.includes("/api/bank-accounts") || path.includes("/api/bank/connections"),
    prefixes: ["bank-overview", "statements", "jobs", "dashboard:"],
  },
  {
    match: (path) => path.includes("/api/customers"),
    prefixes: ["customers", "invoices"],
  },
  {
    match: (path) =>
      path.includes("/api/alv") || path.includes("/api/reports") || path.includes("/api/period-lock"),
    prefixes: ["report:", "alv:", "dashboard:"],
  },
];

export function invalidateForMutation(url: string): string[] {
  const path = url.split("?")[0] ?? url;
  const removed = new Set<string>();
  for (const rule of MUTATION_PREFIXES) {
    if (!rule.match(path)) continue;
    for (const prefix of rule.prefixes) {
      for (const key of clearPageCachePrefix(prefix)) removed.add(key);
    }
  }
  return [...removed];
}
