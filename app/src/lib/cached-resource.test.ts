import { afterEach, describe, expect, it } from "vitest";
import {
  clearPageCache,
  hydratePageCache,
  invalidateForMutation,
  onPageCacheHydrated,
  readPageCache,
  writePageCache,
} from "@/lib/page-cache";
import {
  PURCHASE_COUNTS_KEY,
  UNMATCHED_KEY,
  alvSummaryKey,
  pickCachedValue,
  readCached,
  refreshCached,
  storeCached,
} from "@/lib/cached-resource";

afterEach(() => clearPageCache());

describe("pickCachedValue", () => {
  it("is null (skeleton) when nothing is known, never a made-up zero", () => {
    expect(pickCachedValue("k", null, null, null)).toBeNull();
    expect(pickCachedValue(null, { key: "k", value: 1 }, 2, 3)).toBeNull();
  });

  it("paints the cached copy first, then the copy that became readable after boot", () => {
    expect(pickCachedValue("k", null, 5, 9)).toBe(5);
    expect(pickCachedValue("k", null, null, 9)).toBe(9);
  });

  it("keeps a real zero: 0 is a value, not 'unknown'", () => {
    expect(pickCachedValue("k", null, 0, 9)).toBe(0);
    expect(pickCachedValue("k", { key: "k", value: 0 }, 4, null)).toBe(0);
  });

  it("prefers what the refresh just fetched, but only for the same key", () => {
    expect(pickCachedValue("k", { key: "k", value: 7 }, 5, 9)).toBe(7);
    expect(pickCachedValue("k2", { key: "k", value: 7 }, 5, null)).toBe(5);
    expect(pickCachedValue("k2", { key: "k", value: 7 }, null, null)).toBeNull();
  });
});

describe("refreshCached", () => {
  it("writes a successful refresh through to the page cache", async () => {
    const result = await refreshCached("counts", async () => ({ open: 2 }), new AbortController().signal);
    expect(result).toEqual({ ok: true, value: { open: 2 } });
    expect(readCached("counts")).toEqual({ open: 2 });
  });

  it("a failed refresh keeps the cached value and reports the error", async () => {
    storeCached("counts", { open: 2 });
    const boom = new Error("Load failed");
    const result = await refreshCached(
      "counts",
      async () => {
        throw boom;
      },
      new AbortController().signal
    );
    expect(result).toEqual({ ok: false, error: boom });
    expect(readCached("counts")).toEqual({ open: 2 });
  });

  it("does not cache a result that arrived after the screen left", async () => {
    const controller = new AbortController();
    const pending = refreshCached(
      "counts",
      async () => {
        controller.abort();
        return { open: 9 };
      },
      controller.signal
    );
    await pending;
    expect(readCached("counts")).toBeNull();
  });

  it("reads back the same value the page cache holds", () => {
    writePageCache("x", { a: 1 });
    expect(readCached("x")).toEqual({ a: 1 });
    expect(readCached(null)).toBeNull();
    expect(readPageCache("missing")).toBeNull();
  });
});

describe("cache keys", () => {
  it("keeps the hub values across mutations (quiet refresh) but drops the unmatched list", () => {
    writePageCache(PURCHASE_COUNTS_KEY, { open: 1 });
    writePageCache(alvSummaryKey("2026-08"), { amount: 1, isRefund: false });
    writePageCache(UNMATCHED_KEY, { rows: [] });
    invalidateForMutation("/api/matching/apply");
    expect(readPageCache(UNMATCHED_KEY)).toBeNull();
    expect(readPageCache(PURCHASE_COUNTS_KEY)).not.toBeNull();
    expect(readPageCache(alvSummaryKey("2026-08"))).not.toBeNull();
  });
});

describe("onPageCacheHydrated", () => {
  it("tells a screen that read too early when the persistent records land", () => {
    let reads = 0;
    let seen: unknown = "unset";
    const off = onPageCacheHydrated(() => {
      reads += 1;
      seen = readPageCache("late-key");
    });
    expect(readPageCache("late-key")).toBeNull();
    hydratePageCache([{ key: "page:late-key", userId: "u1", value: { n: 1 }, fetchedAt: Date.now() }]);
    expect(reads).toBe(1);
    expect(seen).toEqual({ n: 1 });
    off();
    hydratePageCache([]);
    expect(reads).toBe(1);
  });
});
