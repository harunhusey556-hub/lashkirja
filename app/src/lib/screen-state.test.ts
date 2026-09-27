import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, ApiGatewayError, ApiTimeoutError } from "@/components/clientFetch";
import {
  clearPageCache,
  invalidateForMutation,
  pageCacheFetchedAt,
  readPageCache,
  writePageCache,
} from "@/lib/page-cache";
import {
  RECEIPT_PHASE,
  armIdleTimeout,
  bumpNavEpoch,
  classifyConnection,
  currentNavEpoch,
  emptyKind,
  errorReference,
  isHonestJobPhase,
  isStaleEpoch,
  resetNavEpochForTests,
  staleBannerText,
  subscribeOverlayClose,
} from "@/lib/screen-state";

afterEach(() => {
  clearPageCache();
  resetNavEpochForTests();
  vi.useRealTimers();
});

describe("classifyConnection", () => {
  it("keeps offline, unreachable, and expired apart", () => {
    expect(classifyConnection(new TypeError("Failed to fetch"), false)).toBe("offline");
    expect(classifyConnection(new TypeError("Failed to fetch"), true)).toBe("unreachable");
    expect(classifyConnection(new ApiTimeoutError(), true)).toBe("unreachable");
    expect(classifyConnection(new ApiGatewayError(503), true)).toBe("unreachable");
    expect(classifyConnection(new ApiError("Ei kirjautunut", 401), true)).toBe("expired");
    expect(classifyConnection(new ApiError("Virheellinen", 400), true)).toBe("generic");
  });
});

describe("page cache invalidation", () => {
  it("records when a copy was stored and drops related screens after a write", () => {
    const at = Date.now();
    writePageCache("invoices", [1], at);
    writePageCache("dashboard:2026-09", { income: 1 }, at);
    writePageCache("receipts:all", [], at);
    writePageCache("profile", { email: "a@b.c" }, at);
    expect(pageCacheFetchedAt("invoices")).toBe(at);

    const removed = invalidateForMutation("/api/invoices/abc/payments");
    expect(removed).toContain("invoices");
    expect(removed).toContain("dashboard:2026-09");
    expect(readPageCache("invoices")).toBeNull();
    expect(readPageCache("receipts:all")).toEqual([]);
    expect(readPageCache("profile")).toEqual({ email: "a@b.c" });
  });

  it("drops receipt lists, including the pending queue, after a receipt write", () => {
    writePageCache("receipts:?q=a", { receipts: [] });
    writePageCache("receipts-pending", []);
    writePageCache("dashboard:2026-09", {});
    invalidateForMutation("https://app.example/api/receipts/save");
    expect(readPageCache("receipts:?q=a")).toBeNull();
    expect(readPageCache("receipts-pending")).toBeNull();
    expect(readPageCache("dashboard:2026-09")).toBeNull();
  });
});

describe("stale banner", () => {
  it("appears only after a failed refresh of a cached copy", () => {
    const at = Date.parse("2026-09-27T08:15:00");
    expect(staleBannerText(at, false, at)).toBeNull();
    expect(staleBannerText(null, true, at)).toBeNull();
    expect(staleBannerText(at, true, at)).toMatch(/^Viimeksi päivitetty tänään klo /);
  });
});

describe("empty taxonomy", () => {
  it("separates no records, filters, failure, and no access", () => {
    expect(emptyKind({ count: 0 })).toBe("records");
    expect(emptyKind({ count: 0, hasActiveFilter: true })).toBe("filtered");
    expect(emptyKind({ count: 0, failed: true })).toBe("failed");
    expect(emptyKind({ count: 3, failed: true })).toBeNull();
    expect(emptyKind({ count: 0, forbidden: true, failed: true })).toBe("forbidden");
  });
});

describe("receipt phases", () => {
  it("uses named phases and never a percentage", () => {
    for (const label of Object.values(RECEIPT_PHASE)) {
      expect(isHonestJobPhase(label)).toBe(true);
      expect(label.includes("%")).toBe(false);
    }
    expect(isHonestJobPhase("42%")).toBe(false);
  });
});

describe("navigation overlays", () => {
  it("closes overlays from the previous screen and ignores a stale open", () => {
    const seen = currentNavEpoch();
    let closed = 0;
    const stop = subscribeOverlayClose(() => {
      closed += 1;
    });
    bumpNavEpoch();
    expect(closed).toBe(1);
    expect(isStaleEpoch(seen)).toBe(true);
    stop();
    bumpNavEpoch();
    expect(closed).toBe(1);
  });
});

describe("stream idle timeout", () => {
  it("fires when no chunk arrives, and resets when one does", () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const idle = armIdleTimeout(1000, onIdle);
    vi.advanceTimersByTime(900);
    idle.bump();
    vi.advanceTimersByTime(900);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(onIdle).toHaveBeenCalledTimes(1);
    idle.stop();
  });
});

describe("error reference", () => {
  it("is a short copyable token, not a stack", () => {
    expect(errorReference("abc1234def", 1)).toBe("LK-abc1234-1");
    expect(errorReference("abc1234def", 1).includes("Error")).toBe(false);
  });
});
