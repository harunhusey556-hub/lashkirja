import { describe, expect, it } from "vitest";
import {
  batchOutcomeMessage,
  cancelPendingWork,
  drainQueue,
  queueProgressCounts,
  queueProgressLabel,
  retryFailedOnly,
} from "./upload-queue";
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

  it("retries only the failed rows of a 240-file pick", () => {
    const rows = Array.from({ length: 240 }, (_, index) => ({
      localId: `r${index}`,
      name: `kuitti-${index}.jpg`,
      status: index === 7 || index === 200 ? ("failed" as const) : ("ready" as const),
      error: index === 7 || index === 200 ? "Lataus epäonnistui" : undefined,
    }));
    const retried = retryFailedOnly(rows);
    expect(retried.filter((row) => row.status === "pending").map((row) => row.localId)).toEqual([
      "r7",
      "r200",
    ]);
    expect(retried.filter((row) => row.status === "ready")).toHaveLength(238);
  });

  it("states success and failure counts", () => {
    expect(batchOutcomeMessage("Hyväksyttiin", 2, 1)).toBe("Hyväksyttiin 2, epäonnistui 1.");
    expect(batchOutcomeMessage("Poistettiin", 1, 0)).toBe("Poistettiin 1, epäonnistui 0.");
  });
});

describe("drainQueue", () => {
  /** Rows are "claimed" synchronously, like uploadOne marks a row before its first await. */
  it("drains 240 files with bounded concurrency, every row terminal", async () => {
    const statuses = Array.from({ length: 240 }, () => "pending");
    let inFlight = 0;
    let peak = 0;
    await drainQueue(
      () => statuses.map((status, index) => ({ localId: `r${index}`, status })),
      async (row) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        statuses[Number(row.localId.slice(1))] = "uploading";
        await Promise.resolve();
        statuses[Number(row.localId.slice(1))] = "ready";
        inFlight -= 1;
      },
      10,
      () => false
    );
    expect(peak).toBeLessThanOrEqual(10);
    expect(statuses.every((status) => status === "ready")).toBe(true);
  });

  it("stops as soon as shouldStop turns true", async () => {
    const statuses = ["pending", "pending", "pending"];
    const processed: string[] = [];
    await drainQueue(
      () => statuses.map((status, index) => ({ localId: `r${index}`, status })),
      async (row) => {
        processed.push(row.localId);
        statuses[Number(row.localId.slice(1))] = "uploading";
        await Promise.resolve();
        statuses[Number(row.localId.slice(1))] = "ready";
      },
      2,
      () => processed.length >= 1
    );
    expect(processed.length).toBeGreaterThanOrEqual(1);
    expect(statuses.some((status) => status === "pending")).toBe(true);
  });
});

describe("queue progress", () => {
  it("counts ready rows against the whole pick", () => {
    const rows = [
      { localId: "a", name: "a.jpg", status: "ready" as const },
      { localId: "b", name: "b.jpg", status: "failed" as const, error: "ei" },
      { localId: "c", name: "c.jpg", status: "pending" as const },
    ];
    expect(queueProgressCounts(rows)).toEqual({ done: 1, total: 3 });
    expect(queueProgressLabel(rows)).toBe("1 / 3 valmista");
    expect(queueProgressLabel([])).toBe("0 / 0 valmista");
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
