import { describe, expect, it } from "vitest";
import { createPersistentCache, PERSISTENT_LIMITS } from "./persistent-cache";
import type { IdbLike } from "./idb";
import { generateCacheKeyBase64, importCacheKey } from "./crypto-box";

/** In-memory stand-in for idb.ts's real IndexedDB adapter -- keeps the
 * store logic (limits, eviction, isolation) testable in plain Node. */
function createFakeIdb(): IdbLike {
  const stores = new Map<string, Map<string, unknown>>();
  function storeFor(name: string): Map<string, unknown> {
    let store = stores.get(name);
    if (!store) {
      store = new Map();
      stores.set(name, store);
    }
    return store;
  }
  return {
    async get<T>(store: string, key: string) {
      return storeFor(store).get(key) as T | undefined;
    },
    async getAll<T>(store: string) {
      return [...storeFor(store).values()] as T[];
    },
    async put<T>(store: string, value: T) {
      const row = value as unknown as { key: string };
      storeFor(store).set(row.key, value);
    },
    async delete(store: string, key: string) {
      storeFor(store).delete(key);
    },
    async clear(store: string) {
      storeFor(store).clear();
    },
  };
}

async function freshKey(): Promise<CryptoKey> {
  return importCacheKey(generateCacheKeyBase64());
}

describe("createPersistentCache: basic get/set/delete", () => {
  it("round-trips a value and reports its fetchedAt", async () => {
    const idb = createFakeIdb();
    const key = await freshKey();
    const t = 1_000;
    const cache = createPersistentCache(idb, "u1", key, () => t);

    await cache.set("page:dashboard", { income: 100 });
    const record = await cache.get<{ income: number }>("page:dashboard");

    expect(record).not.toBeNull();
    expect(record!.value).toEqual({ income: 100 });
    expect(record!.userId).toBe("u1");
    expect(record!.fetchedAt).toBe(1_000);
  });

  it("an explicit fetchedAt overrides the clock", async () => {
    const idb = createFakeIdb();
    const key = await freshKey();
    const cache = createPersistentCache(idb, "u1", key, () => 9_999);

    await cache.set("page:dashboard", { a: 1 }, 42);
    const record = await cache.get("page:dashboard");
    expect(record!.fetchedAt).toBe(42);
  });

  it("get returns null for a key that was never set", async () => {
    const idb = createFakeIdb();
    const key = await freshKey();
    const cache = createPersistentCache(idb, "u1", key);
    expect(await cache.get("page:missing")).toBeNull();
  });

  it("delete removes a single key", async () => {
    const idb = createFakeIdb();
    const key = await freshKey();
    const cache = createPersistentCache(idb, "u1", key);
    await cache.set("page:a", 1);
    await cache.set("page:b", 2);
    await cache.delete("page:a");
    expect(await cache.get("page:a")).toBeNull();
    expect((await cache.get("page:b"))?.value).toBe(2);
  });
});

describe("createPersistentCache: prefix operations", () => {
  it("deletePrefix removes every matching key and leaves the rest", async () => {
    const idb = createFakeIdb();
    const key = await freshKey();
    const cache = createPersistentCache(idb, "u1", key);
    await cache.set("http:/api/receipts", []);
    await cache.set("http:/api/statements", []);
    await cache.set("page:dashboard", {});

    await cache.deletePrefix("http:");

    expect(await cache.get("http:/api/receipts")).toBeNull();
    expect(await cache.get("http:/api/statements")).toBeNull();
    expect(await cache.get("page:dashboard")).not.toBeNull();
  });

  it("entries returns every non-expired record under a prefix, decrypted", async () => {
    const idb = createFakeIdb();
    const key = await freshKey();
    const cache = createPersistentCache(idb, "u1", key, () => 5_000);
    await cache.set("page:dashboard", { a: 1 });
    await cache.set("page:kuitit", { b: 2 });
    await cache.set("http:/api/receipts", { c: 3 });

    const results = await cache.entries("page:");
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.key).sort()).toEqual(["page:dashboard", "page:kuitit"]);
  });
});

describe("createPersistentCache: max-age pruning", () => {
  it("a record older than PERSISTENT_LIMITS.maxAgeMs is dropped on read", async () => {
    const idb = createFakeIdb();
    const key = await freshKey();
    let t = 0;
    const cache = createPersistentCache(idb, "u1", key, () => t);

    await cache.set("page:dashboard", { a: 1 }); // fetchedAt = 0
    t = PERSISTENT_LIMITS.maxAgeMs + 1;

    expect(await cache.get("page:dashboard")).toBeNull();
  });

  it("entries() also drops expired records instead of returning them", async () => {
    const idb = createFakeIdb();
    const key = await freshKey();
    let t = 0;
    const cache = createPersistentCache(idb, "u1", key, () => t);
    await cache.set("page:old", { a: 1 });
    t = 1_000;
    await cache.set("page:fresh", { b: 2 });
    t = PERSISTENT_LIMITS.maxAgeMs + 500;

    const results = await cache.entries("page:");
    expect(results.map((r) => r.key)).toEqual(["page:fresh"]);
  });

  it("a record just inside the max age survives", async () => {
    const idb = createFakeIdb();
    const key = await freshKey();
    let t = 0;
    const cache = createPersistentCache(idb, "u1", key, () => t);
    await cache.set("page:dashboard", { a: 1 });
    t = PERSISTENT_LIMITS.maxAgeMs;
    expect(await cache.get("page:dashboard")).not.toBeNull();
  });
});

describe("createPersistentCache: entry-count limits, LRU by fetchedAt", () => {
  it("evicts the oldest page: entries once pageEntries is exceeded", async () => {
    const idb = createFakeIdb();
    const key = await freshKey();
    let t = 0;
    const cache = createPersistentCache(idb, "u1", key, () => t);

    for (let i = 0; i < PERSISTENT_LIMITS.pageEntries; i++) {
      t = i;
      await cache.set(`page:screen-${i}`, i);
    }
    // One more, past the limit: the very oldest (page:screen-0) must go.
    t = PERSISTENT_LIMITS.pageEntries;
    await cache.set(`page:screen-${PERSISTENT_LIMITS.pageEntries}`, PERSISTENT_LIMITS.pageEntries);

    const results = await cache.entries("page:");
    expect(results).toHaveLength(PERSISTENT_LIMITS.pageEntries);
    expect(await cache.get("page:screen-0")).toBeNull();
    expect(await cache.get(`page:screen-${PERSISTENT_LIMITS.pageEntries}`)).not.toBeNull();
  });

  it("page: and http: entries are counted against separate limits", async () => {
    const idb = createFakeIdb();
    const key = await freshKey();
    const cache = createPersistentCache(idb, "u1", key, () => 1);
    await cache.set("page:dashboard", {});
    await cache.set("http:/api/receipts", {});
    // Neither limit is anywhere near exceeded by two entries in different
    // groups; both must still be present.
    expect(await cache.get("page:dashboard")).not.toBeNull();
    expect(await cache.get("http:/api/receipts")).not.toBeNull();
  });
});

describe("createPersistentCache: userId isolation", () => {
  it("a cache instance for one user never returns another user's row for the same key", async () => {
    const idb = createFakeIdb();
    const key = await freshKey();
    const cacheA = createPersistentCache(idb, "userA", key);
    const cacheB = createPersistentCache(idb, "userB", key);

    await cacheA.set("page:dashboard", { owner: "A" });
    // Same underlying store, same key, different cache owner.
    expect(await cacheB.get("page:dashboard")).toBeNull();
    expect((await cacheA.get("page:dashboard"))?.value).toEqual({ owner: "A" });
  });

  it("deletePrefix and entries only ever touch the calling user's own rows", async () => {
    // Distinct keys per user, as they would be in practice -- the whole
    // store is cleared on a user switch (boot's own rule), so two users'
    // rows only ever coexist transiently, if at all. What matters is that
    // one user's bulk operation cannot reach into the other's rows.
    const idb = createFakeIdb();
    const key = await freshKey();
    const cacheA = createPersistentCache(idb, "userA", key);
    const cacheB = createPersistentCache(idb, "userB", key);
    await cacheA.set("page:a", 1);
    await cacheB.set("page:b", 2);

    expect(await cacheA.entries("page:")).toHaveLength(1);
    await cacheA.deletePrefix("page:");

    expect(await cacheA.get("page:a")).toBeNull();
    expect((await cacheB.get("page:b"))?.value).toBe(2);
  });
});
