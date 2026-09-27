/**
 * Last-seen payload per screen, kept in memory for the tab's lifetime.
 *
 * Navigating back to a list should show that list, not a spinner over an empty
 * page. The cached copy is painted immediately and replaced as soon as the
 * fetch that always follows returns. `fetchedAt` lets the screen say when that
 * copy was last successful, so a failed refresh is not painted as fresh.
 *
 * Deliberately not persisted: bookkeeping data has no business surviving in
 * storage after the tab is closed.
 */
const cache = new Map<string, unknown>();
const fetchedAt = new Map<string, number>();

export function readPageCache<T>(key: string): T | null {
  return (cache.get(key) as T | undefined) ?? null;
}

export function pageCacheFetchedAt(key: string): number | null {
  return fetchedAt.get(key) ?? null;
}

export function writePageCache<T>(key: string, value: T, at = Date.now()): void {
  cache.set(key, value);
  fetchedAt.set(key, at);
}

function dropKey(key: string): void {
  cache.delete(key);
  fetchedAt.delete(key);
}

/** Called after a mutation when the next screen must not show a stale copy. */
export function clearPageCache(key?: string): void {
  if (key) dropKey(key);
  else {
    cache.clear();
    fetchedAt.clear();
  }
}

export function clearPageCachePrefix(prefix: string): string[] {
  const removed: string[] = [];
  for (const key of cache.keys()) {
    if (key === prefix || key.startsWith(prefix)) {
      dropKey(key);
      removed.push(key);
    }
  }
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
