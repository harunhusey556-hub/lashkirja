import { prisma } from "@/lib/db";
import { readDataVersion } from "@/lib/data-version";
import { DUPLICATE_DISMISSED_KIND } from "@/lib/alv-period";

/**
 * Koti's heavy figures (year turnover, six-month cashflow, the month's books) depend only on the
 * user's bank, receipt and invoice rows. Those rows bump DataVersion on every write (SQLite
 * triggers, migration 20261015090000_data_version), so a figure computed at one version is still
 * true at that version: Koti reuses it instead of reloading a year of documents (~200 ms) on
 * every open (W24). In-process memory, not a table: the web server is one process, a restart only
 * costs one cold open, and nothing new has to be kept in step with the schema.
 */

/** Many users times a few figures each; the oldest entry goes first. */
const MAX_ENTRIES = 512;
const entries = new Map<string, { stamp: string; value: Promise<unknown> }>();

/**
 * What the cached figures depend on, as one string. DataVersion covers every table they read
 * except the "these two incomes are separate" dismissals (AutomationEvent, no trigger), which
 * alv-period reads to decide whether a receipt and an invoice payment are one income or two.
 */
export async function readBooksStamp(userId: string): Promise<string> {
  const [version, dismissed] = await Promise.all([
    readDataVersion(userId),
    prisma.automationEvent.count({ where: { userId, kind: DUPLICATE_DISMISSED_KIND } }),
  ]);
  return `${version}.${dismissed}`;
}

/**
 * `load()` once per (key, stamp). The promise is cached, so two Koti opens at once share one load;
 * a failed load is dropped so the next open retries. `key` must name the user and every input of
 * `load` that is not in the stamp (year, month, VAT rate).
 */
export function cachedForStamp<T>(key: string, stamp: string, load: () => Promise<T>): Promise<T> {
  const hit = entries.get(key);
  if (hit && hit.stamp === stamp) return hit.value as Promise<T>;
  const value = load();
  entries.delete(key);
  entries.set(key, { stamp, value });
  if (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value;
    if (oldest !== undefined) entries.delete(oldest);
  }
  value.catch(() => {
    if (entries.get(key)?.value === value) entries.delete(key);
  });
  return value;
}
