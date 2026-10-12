import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECEIPT_QUERY,
  RECEIPT_PAGE_SIZE,
  appendReceiptPage,
  nextPageParams,
  readReceiptPage,
  receiptPageQuery,
  reuseEqualReceipts,
} from "./receipt-paging";

const row = (id: string, vendor = "Kauppa") => ({ id, vendor });

describe("receiptPageQuery", () => {
  it("asks for one page of 50 on top of the screen's own filters", () => {
    const params = new URLSearchParams(receiptPageQuery(DEFAULT_RECEIPT_QUERY));
    expect(params.get("limit")).toBe(String(RECEIPT_PAGE_SIZE));
    expect(params.get("kind")).toBe("receipt");
    expect(params.get("sort")).toBe("date_desc");
    expect(params.has("cursor")).toBe(false);
    expect(params.has("offset")).toBe(false);
  });

  it("pages by cursor when the server gave one, else by offset", () => {
    expect(new URLSearchParams(receiptPageQuery("kind=receipt", { cursor: "abc" })).get("cursor")).toBe("abc");
    expect(new URLSearchParams(receiptPageQuery("kind=receipt", { offset: 50 })).get("offset")).toBe("50");
    expect(new URLSearchParams(receiptPageQuery("kind=receipt", { cursor: "abc", offset: 50 })).has("offset")).toBe(false);
  });
});

describe("readReceiptPage", () => {
  it("reads the cursor answer", () => {
    const page = readReceiptPage({ receipts: [row("a")], count: 120, nextCursor: "c1" });
    expect(page).toEqual({ receipts: [row("a")], count: 120, truncated: true, nextCursor: "c1" });
  });

  it("reads the older offset answer", () => {
    const page = readReceiptPage({ receipts: [row("a")], count: 300, truncated: true });
    expect(page.truncated).toBe(true);
    expect(page.nextCursor).toBeNull();
  });

  it("is not truncated on the last page", () => {
    expect(readReceiptPage({ receipts: [row("a")], count: 1, nextCursor: null }).truncated).toBe(false);
    expect(readReceiptPage({}).receipts).toEqual([]);
  });
});

describe("nextPageParams / appendReceiptPage", () => {
  it("uses the cursor, else the number of rows held", () => {
    expect(nextPageParams({ receipts: [row("a")], count: 9, truncated: true, nextCursor: "c" })).toEqual({ cursor: "c" });
    expect(nextPageParams({ receipts: [row("a"), row("b")], count: 9, truncated: true })).toEqual({ offset: 2 });
  });

  it("appends a page without showing a moved row twice", () => {
    const first = readReceiptPage({ receipts: [row("a"), row("b")], count: 4, nextCursor: "c1" });
    const second = readReceiptPage({ receipts: [row("b"), row("c")], count: 4, nextCursor: null });
    const merged = appendReceiptPage(first, second);
    expect(merged.receipts.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(merged.truncated).toBe(false);
    expect(merged.nextCursor).toBeNull();
  });
});

describe("reuseEqualReceipts", () => {
  it("keeps the old array and objects when nothing changed", () => {
    const before = [row("a"), row("b")];
    const after = [row("a"), row("b")];
    expect(reuseEqualReceipts(before, after)).toBe(before);
  });

  it("keeps the objects of unchanged rows when one row changed", () => {
    const before = [row("a"), row("b")];
    const after = [row("a"), row("b", "Uusi")];
    const merged = reuseEqualReceipts(before, after);
    expect(merged).not.toBe(before);
    expect(merged[0]).toBe(before[0]);
    expect(merged[1]).toBe(after[1]);
  });

  it("returns the new rows when there was nothing before", () => {
    const after = [row("a")];
    expect(reuseEqualReceipts([], after)).toBe(after);
  });
});
