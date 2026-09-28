import { afterEach, describe, expect, it } from "vitest";
import { configureHttpCachePersistence, isCacheableGet, rememberGet, staleResponseFor } from "./http-cache";
import { PERSISTENT_LIMITS } from "./persistent-cache";
import type { CacheRecord, PersistentCache } from "./persistent-cache";

/** Direct, unencrypted in-memory PersistentCache -- these tests exercise
 * http-cache.ts's own logic, not persistent-cache.ts's (covered by its
 * own test file). */
function createFakeStore(): PersistentCache {
  const rows = new Map<string, CacheRecord>();
  return {
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
}

function jsonResponse(body: unknown, init: { status?: number; contentType?: string } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": init.contentType ?? "application/json; charset=utf-8" },
  });
}

afterEach(() => {
  configureHttpCachePersistence(null);
});

describe("isCacheableGet", () => {
  const table: Array<[string, string, { status?: number; contentType?: string }, boolean]> = [
    ["a plain JSON 200 under /api/", "/api/receipts", {}, true],
    ["a JSON 200 with a query string", "/api/receipts?sort=date_desc", {}, true],
    ["a non-200 status", "/api/receipts", { status: 500 }, false],
    ["a non-JSON content type", "/api/receipts", { contentType: "text/html" }, false],
    ["outside /api/", "/login", {}, false],
    ["/api/auth/*", "/api/auth/me", {}, false],
    ["/api/jobs/*", "/api/jobs/123", {}, false],
    ["/api/health exactly", "/api/health", {}, false],
    ["/api/observe exactly", "/api/observe", {}, false],
  ];

  for (const [label, path, responseInit, expected] of table) {
    it(`${label} -> ${expected}`, () => {
      const response = jsonResponse({ ok: true }, responseInit);
      expect(isCacheableGet(`http://127.0.0.1:3200${path}`, response)).toBe(expected);
    });
  }
});

describe("rememberGet / staleResponseFor", () => {
  it("is a no-op with nothing configured (never throws)", async () => {
    await expect(rememberGet("http://x/api/receipts", jsonResponse([]))).resolves.toBeUndefined();
    expect(await staleResponseFor("http://x/api/receipts")).toBeNull();
  });

  it("round-trips a cacheable response, with the stale headers set", async () => {
    const store = createFakeStore();
    configureHttpCachePersistence(store);
    const response = jsonResponse({ receipts: [1, 2, 3] });

    await rememberGet("http://127.0.0.1:3200/api/receipts?sort=date_desc", response);
    const stale = await staleResponseFor("http://127.0.0.1:3200/api/receipts?sort=date_desc");

    expect(stale).not.toBeNull();
    expect(stale!.headers.get("X-LashKirja-Cache")).toBe("stale");
    expect(stale!.headers.get("X-LashKirja-Fetched-At")).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(await stale!.json()).toEqual({ receipts: [1, 2, 3] });
  });

  it("never remembers a response isCacheableGet rejects", async () => {
    const store = createFakeStore();
    configureHttpCachePersistence(store);
    await rememberGet("http://127.0.0.1:3200/api/auth/me", jsonResponse({ user: {} }));
    expect(await staleResponseFor("http://127.0.0.1:3200/api/auth/me")).toBeNull();
  });

  it("never remembers a body larger than httpBodyMaxBytes", async () => {
    const store = createFakeStore();
    configureHttpCachePersistence(store);
    const big = "x".repeat(PERSISTENT_LIMITS.httpBodyMaxBytes + 10);
    const response = new Response(JSON.stringify({ big }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    await rememberGet("http://127.0.0.1:3200/api/receipts", response);
    expect(await staleResponseFor("http://127.0.0.1:3200/api/receipts")).toBeNull();
  });

  it("a still-original response body is unaffected by rememberGet reading a clone", async () => {
    const store = createFakeStore();
    configureHttpCachePersistence(store);
    const response = jsonResponse({ ok: true });
    await rememberGet("http://127.0.0.1:3200/api/receipts", response);
    // The original response's body must still be readable by the caller
    // that passed it in -- rememberGet only ever reads response.clone().
    expect(await response.json()).toEqual({ ok: true });
  });

  it("misses for a URL that was never remembered", async () => {
    configureHttpCachePersistence(createFakeStore());
    expect(await staleResponseFor("http://127.0.0.1:3200/api/statements")).toBeNull();
  });
});
