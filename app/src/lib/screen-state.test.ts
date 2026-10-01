import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, ApiGatewayError, ApiTimeoutError, ERROR_COPY } from "@/components/clientFetch";
import {
  clearPageCache,
  invalidateForMutation,
  pageCacheFetchedAt,
  readPageCache,
  writePageCache,
} from "@/lib/page-cache";
import { claimConnectionNotice, connectionNoticeClaims } from "@/lib/connection-notice";
import {
  ERROR_TITLE,
  RECEIPT_PHASE,
  STALE_COPY,
  STALE_SUFFIX,
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

  it("recognises a failure a hook already turned into its fixed copy", () => {
    expect(classifyConnection(new Error(ERROR_COPY.offline), true)).toBe("offline");
    expect(classifyConnection(new Error(ERROR_COPY.unreachable), true)).toBe("unreachable");
    expect(classifyConnection(new Error(ERROR_COPY.expired), true)).toBe("expired");
    expect(classifyConnection(new Error("Kuittia ei löytynyt"), true)).toBe("generic");
  });
});

describe("state wording (VS-31, VS-32)", () => {
  it("has one error title and one stale sentence", () => {
    expect(ERROR_TITLE).toBe("Jotain meni pieleen");
    expect(STALE_COPY.offline).toBe("Ei verkkoyhteyttä. Näytetään viimeksi haetut tiedot.");
    for (const copy of Object.values(STALE_COPY)) expect(copy.endsWith(STALE_SUFFIX)).toBe(true);
  });

  it("counts page cards that own the connection message, and releases them", () => {
    const release = claimConnectionNotice();
    const releaseAgain = claimConnectionNotice();
    expect(connectionNoticeClaims()).toBe(2);
    release();
    release(); // a double release must not release the other card's claim
    expect(connectionNoticeClaims()).toBe(1);
    releaseAgain();
    expect(connectionNoticeClaims()).toBe(0);
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

describe("onboarding changes what Koti, Kirjanpito and the ALV page show (F21)", () => {
  it("drops the cached profile, dashboard and ALV figures after the onboarding write", () => {
    writePageCache("profile", { vatRegistered: false });
    writePageCache("dashboard:2026-10", {});
    writePageCache("alv-summary:2026-09", {});
    writePageCache("alv:2026-09", {});
    writePageCache("invoices", []);
    invalidateForMutation("/api/onboarding");
    expect(readPageCache("profile")).toBeNull();
    expect(readPageCache("dashboard:2026-10")).toBeNull();
    expect(readPageCache("alv-summary:2026-09")).toBeNull();
    expect(readPageCache("alv:2026-09")).toBeNull();
    expect(readPageCache("invoices")).toEqual([]);
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
