import { describe, expect, it } from "vitest";
import { keepPendingTab, PENDING_TAB_TIMEOUT_MS } from "@/lib/pending-tab";

describe("keepPendingTab", () => {
  const pending = { id: "myynti", from: "/dashboard" };

  it("keeps the tapped tab lit while the screen it was tapped on is still showing", () => {
    expect(keepPendingTab(pending, "/dashboard")).toBe(pending);
  });

  it("drops it once the path changes, to the target or anywhere else", () => {
    expect(keepPendingTab(pending, "/laskut")).toBeNull();
    expect(keepPendingTab(pending, "/asetukset/profiili")).toBeNull();
    expect(keepPendingTab(null, "/dashboard")).toBeNull();
  });

  it("has a timeout short enough that a push that never lands does not leave a stale highlight", () => {
    expect(PENDING_TAB_TIMEOUT_MS).toBeGreaterThan(0);
    expect(PENDING_TAB_TIMEOUT_MS).toBeLessThanOrEqual(5000);
  });
});
