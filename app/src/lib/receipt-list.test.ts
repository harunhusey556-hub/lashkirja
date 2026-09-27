import { describe, expect, it } from "vitest";
import {
  coerceReceiptListCache,
  dropReceipt,
  mergeReceiptPage,
  receiptCountLabel,
} from "./receipt-list";

describe("receipt list pages", () => {
  it("replaces the first page and appends the next", () => {
    const first = mergeReceiptPage(
      [{ id: "stale" }],
      { receipts: [{ id: "a" }, { id: "b" }], count: 3, truncated: true },
      0
    );
    expect(first.receipts.map((row) => row.id)).toEqual(["a", "b"]);
    expect(first.count).toBe(3);
    expect(first.truncated).toBe(true);

    const second = mergeReceiptPage(
      first.receipts,
      { receipts: [{ id: "c" }], count: 3, truncated: false },
      first.receipts.length
    );
    expect(second.receipts.map((row) => row.id)).toEqual(["a", "b", "c"]);
    expect(second.truncated).toBe(false);
  });

  it("reads an older array cache without pretending the list is complete", () => {
    expect(coerceReceiptListCache([{ id: "a" }])).toEqual({
      receipts: [{ id: "a" }],
      count: 1,
      truncated: false,
    });
  });

  it("keeps the server total when a loaded row is removed", () => {
    const next = dropReceipt(
      { receipts: [{ id: "a" }, { id: "b" }], count: 201, truncated: true },
      "a"
    );
    expect(next.receipts).toEqual([{ id: "b" }]);
    expect(next.count).toBe(200);
    expect(next.truncated).toBe(true);
  });

  it("labels the total, not the loaded page", () => {
    expect(receiptCountLabel(201, false)).toBe("201 kuittia");
    expect(receiptCountLabel(1, true)).toBe("1 kuitti (suodatettu)");
  });
});
