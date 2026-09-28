import { afterEach, describe, expect, it } from "vitest";
import {
  PAGE_CACHE_MAX_ENTRIES,
  PAGE_CACHE_TTL_MS,
  clearPageCache,
  clearPageCachePrefix,
  configurePageCachePersistence,
  hydratePageCache,
  pageCacheSize,
  readPageCache,
  writePageCache,
} from "@/lib/page-cache";
import type { CacheRecord, PersistentCache } from "@/lib/offline/persistent-cache";

afterEach(() => {
  clearPageCache();
  configurePageCachePersistence(null);
});

/** Direct, in-memory PersistentCache stand-in -- these tests only exercise
 * page-cache.ts's own write-through/invalidate-mirror wiring, not
 * persistent-cache.ts's internals (its own test file). */
function createFakeStore(): { store: PersistentCache; rows: Map<string, CacheRecord> } {
  const rows = new Map<string, CacheRecord>();
  const store: PersistentCache = {
    async get<T>(key: string) {
      return (rows.get(key) as CacheRecord<T> | undefined) ?? null;
    },
    async set<T>(key: string, value: T, fetchedAt = Date.now()) {
      rows.set(key, { key, userId: "u1", fetchedAt, value });
    },
    async delete(key: string) {
      rows.delete(key);
    },
    async deletePrefix(prefix: string) {
      for (const key of rows.keys()) if (key.startsWith(prefix)) rows.delete(key);
    },
    async entries(prefix: string) {
      return [...rows.values()].filter((row) => row.key.startsWith(prefix));
    },
    async clear() {
      rows.clear();
    },
  };
  return { store, rows };
}

describe("page cache bounds", () => {
  it("drops a copy after the TTL", () => {
    const at = 1_700_000_000_000;
    writePageCache("receipts", { rows: 1 }, at);
    expect(readPageCache("receipts", at + PAGE_CACHE_TTL_MS)).toEqual({ rows: 1 });
    expect(readPageCache("receipts", at + PAGE_CACHE_TTL_MS + 1)).toBeNull();
  });

  it("keeps only the newest entries", () => {
    for (let index = 0; index < PAGE_CACHE_MAX_ENTRIES + 5; index += 1) {
      writePageCache(`key-${index}`, index, 1_000 + index);
    }
    expect(pageCacheSize()).toBe(PAGE_CACHE_MAX_ENTRIES);
    expect(readPageCache("key-0", 2_000)).toBeNull();
    expect(readPageCache(`key-${PAGE_CACHE_MAX_ENTRIES + 4}`, 2_000)).toBe(PAGE_CACHE_MAX_ENTRIES + 4);
  });
});

describe("persistence wiring (Task 7, mobile only)", () => {
  it("writePageCache writes through to the configured store under page:<key>", async () => {
    const { store, rows } = createFakeStore();
    configurePageCachePersistence(store, 1_000, 10);

    writePageCache("dashboard:2026-01", { income: 1 }, 500);
    await Promise.resolve(); // let the fire-and-forget write settle
    await Promise.resolve();

    expect(rows.get("page:dashboard:2026-01")).toEqual({
      key: "page:dashboard:2026-01",
      userId: "u1",
      fetchedAt: 500,
      value: { income: 1 },
    });
  });

  it("clearPageCache(key) and clearPageCache() also delete persistently", async () => {
    const { store, rows } = createFakeStore();
    configurePageCachePersistence(store, 1_000, 10);
    writePageCache("a", 1);
    writePageCache("b", 2);
    await Promise.resolve();
    await Promise.resolve();

    clearPageCache("a");
    await Promise.resolve();
    expect(rows.has("page:a")).toBe(false);
    expect(rows.has("page:b")).toBe(true);

    clearPageCache();
    await Promise.resolve();
    expect(rows.size).toBe(0);
  });

  it("clearPageCachePrefix mirrors the deletion persistently (invalidateForMutation's own path)", async () => {
    const { store, rows } = createFakeStore();
    configurePageCachePersistence(store, 1_000, 10);
    writePageCache("receipts:sort=date_desc", []);
    writePageCache("receipts-pending", []);
    writePageCache("statements", []);
    await Promise.resolve();
    await Promise.resolve();

    clearPageCachePrefix("receipts");
    await Promise.resolve();

    expect(rows.has("page:receipts:sort=date_desc")).toBe(false);
    expect(rows.has("page:receipts-pending")).toBe(false);
    expect(rows.has("page:statements")).toBe(true);
  });

  it("configuring a store with no arguments applies the mobile 30-day/80-entry defaults", () => {
    const { store } = createFakeStore();
    configurePageCachePersistence(store, 30 * 24 * 60 * 60 * 1000, 80);
    writePageCache("dashboard", { a: 1 }, 0);
    // Well past the web 5-minute TTL, still within the 30-day one.
    expect(readPageCache("dashboard", PAGE_CACHE_TTL_MS + 1)).toEqual({ a: 1 });
  });

  it("configuring null restores the web defaults (5 min TTL, 40 entries)", () => {
    configurePageCachePersistence(null);
    writePageCache("dashboard", { a: 1 }, 0);
    expect(readPageCache("dashboard", PAGE_CACHE_TTL_MS + 1)).toBeNull();
  });

  it("hydratePageCache seeds the map but never overwrites a value already written", () => {
    writePageCache("dashboard", { fromNetwork: true }, 900);

    hydratePageCache([
      { key: "page:dashboard", userId: "u1", fetchedAt: 100, value: { fromDisk: true } },
      { key: "page:receipts", userId: "u1", fetchedAt: 200, value: { fromDisk: true } },
      { key: "http:/api/receipts", userId: "u1", fetchedAt: 300, value: { ignored: true } },
    ]);

    expect(readPageCache("dashboard", 1_000)).toEqual({ fromNetwork: true });
    expect(readPageCache("receipts", 1_000)).toEqual({ fromDisk: true });
  });
});
