/**
 * Last-seen payload per screen, kept in memory for the tab's lifetime.
 *
 * Navigating back to a list should show that list, not a spinner over an empty
 * page. The cached copy is painted immediately and replaced as soon as the
 * fetch that always follows returns, so nothing is ever shown as fresh when it
 * is not - it is just shown at all.
 *
 * Deliberately not persisted: bookkeeping data has no business surviving in
 * storage after the tab is closed.
 */
const cache = new Map<string, unknown>();

export function readPageCache<T>(key: string): T | null {
  return (cache.get(key) as T | undefined) ?? null;
}

export function writePageCache<T>(key: string, value: T): void {
  cache.set(key, value);
}

/** Called after a mutation when the next screen must not show a stale copy. */
export function clearPageCache(key?: string): void {
  if (key) cache.delete(key);
  else cache.clear();
}
