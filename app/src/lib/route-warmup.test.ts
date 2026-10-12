import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { apiFetch } = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("@/components/clientFetch", () => ({ apiFetch }));

import { clearPageCache, readPageCache, writePageCache } from "./page-cache";
import { warmReceipt, warmRoute } from "./route-warmup";
import { DEFAULT_RECEIPT_COUNTS_QUERY, DEFAULT_RECEIPT_QUERY } from "./receipt-paging";

function answer(body: unknown) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
}

describe("route warm-up", () => {
  beforeEach(() => {
    clearPageCache();
    apiFetch.mockReset();
  });
  afterEach(() => clearPageCache());

  it("puts the Kuitit first page, queue and counts under the keys the page reads", async () => {
    apiFetch.mockImplementation((url: string) => {
      if (url.startsWith("/api/receipts/counts")) return answer({ counts: { all: 3 } });
      return answer({ receipts: [{ id: "a" }], count: 1, nextCursor: null });
    });
    await warmRoute("/kuitit");
    const list = readPageCache<{ receipts: unknown[]; count: number }>(`receipts:${DEFAULT_RECEIPT_QUERY}`);
    expect(list?.receipts).toHaveLength(1);
    expect(readPageCache("receipts-pending")).not.toBeNull();
    expect(readPageCache(`receipt-counts:${DEFAULT_RECEIPT_COUNTS_QUERY}`)).toEqual({ all: 3 });
    const urls = apiFetch.mock.calls.map((call) => call[0] as string);
    expect(urls.some((url) => url.includes("limit=50"))).toBe(true);
  });

  it("never fetches or overwrites a screen that is already cached", async () => {
    writePageCache("invoices", { invoices: [], aging: {} });
    apiFetch.mockImplementation(() => answer({ invoices: [1], aging: {} }));
    await warmRoute("/laskut");
    expect(apiFetch).not.toHaveBeenCalled();
    expect(readPageCache<{ invoices: unknown[] }>("invoices")?.invoices).toEqual([]);
  });

  it("sends one request per key at a time", async () => {
    apiFetch.mockImplementation(() => answer({ receipt: { id: "r1" } }));
    await Promise.all([warmReceipt("r1"), warmReceipt("r1")]);
    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(readPageCache("receipt:r1")).toEqual({ id: "r1" });
  });

  it("swallows a failed warm-up: the page's own fetch shows the error", async () => {
    apiFetch.mockImplementation(() => Promise.reject(new Error("offline")));
    await expect(warmRoute("/raportit")).resolves.toBeUndefined();
    expect(readPageCache(`report:${new Date().getUTCFullYear()}`)).toBeNull();
  });
});
