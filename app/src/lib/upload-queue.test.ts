import { describe, expect, it } from "vitest";
import { batchOutcomeMessage, cancelPendingWork, retryFailedOnly } from "./upload-queue";
import { isLowConfidenceField } from "./receipt-confidence";
import { normalizeVendorKey } from "./vendor-rules";

describe("upload queue", () => {
  it("cancels unfinished files and retries only failures", () => {
    const items = [
      { localId: "a", name: "a.jpg", status: "ready" as const },
      { localId: "b", name: "b.jpg", status: "failed" as const, error: "ei" },
      { localId: "c", name: "c.jpg", status: "pending" as const },
      { localId: "d", name: "d.jpg", status: "processing" as const },
    ];
    expect(cancelPendingWork(items).map((item) => item.status)).toEqual([
      "ready",
      "failed",
      "cancelled",
      "cancelled",
    ]);
    expect(retryFailedOnly(items).map((item) => item.status)).toEqual([
      "ready",
      "pending",
      "pending",
      "processing",
    ]);
  });

  it("states success and failure counts", () => {
    expect(batchOutcomeMessage("Hyväksyttiin", 2, 1)).toBe("Hyväksyttiin 2, epäonnistui 1.");
    expect(batchOutcomeMessage("Poistettiin", 1, 0)).toBe("Poistettiin 1, epäonnistui 0.");
  });
});

describe("receipt confidence", () => {
  it("highlights empty fields and low scores", () => {
    expect(isLowConfidenceField({ value: "", overall: 0.9 })).toBe(true);
    expect(isLowConfidenceField({ value: "K", overall: 0.2 })).toBe(true);
    expect(isLowConfidenceField({ value: "K", overall: 0.2, field: 0.9 })).toBe(false);
    expect(isLowConfidenceField({ value: "K", overall: 0.9 })).toBe(false);
  });
});

describe("vendor rules", () => {
  it("normalizes a vendor without creating a rule by itself", () => {
    expect(normalizeVendorKey("  K-Market   Helsinki ")).toBe("k-market helsinki");
    expect(normalizeVendorKey("   ")).toBe("");
  });
});
