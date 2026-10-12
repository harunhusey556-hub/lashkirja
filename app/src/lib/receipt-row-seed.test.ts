import { beforeEach, describe, expect, it } from "vitest";
import { clearReceiptRowSeeds, recallReceiptRow, rememberReceiptRows } from "./receipt-row-seed";
import { hasReceiptThumb, receiptThumbSrc, receiptThumbUrl } from "./receipt-thumb";
import { inlinePreviewSrc } from "@/components/ReceiptPreview";

describe("receipt row seed", () => {
  beforeEach(() => clearReceiptRowSeeds());

  it("recalls a row the list showed, and nothing for an unknown id", () => {
    rememberReceiptRows([{ id: "r1", vendor: "Kahvila" }]);
    expect(recallReceiptRow<{ vendor: string }>("r1")?.vendor).toBe("Kahvila");
    expect(recallReceiptRow("r2")).toBeUndefined();
  });

  it("keeps at most 500 rows, dropping the oldest", () => {
    rememberReceiptRows(Array.from({ length: 520 }, (_, i) => ({ id: `r${i}` })));
    expect(recallReceiptRow("r0")).toBeUndefined();
    expect(recallReceiptRow("r519")).toBeDefined();
  });
});

describe("receipt thumbnails", () => {
  it("asks for the small copy, never the upload", () => {
    const url = receiptThumbUrl("abc");
    expect(url).toBe("/api/receipts/abc/file/preview?w=160");
    expect(url).not.toMatch(/\/file$/);
  });

  it("shows a picture only for a receipt that has a file", () => {
    expect(hasReceiptThumb({ fileName: "kuitti.jpg" })).toBe(true);
    expect(hasReceiptThumb({ fileName: "" })).toBe(false);
    expect(hasReceiptThumb({ hasThumbnail: false, fileName: "x.jpg" })).toBe(false);
    expect(hasReceiptThumb({ hasFile: true })).toBe(true);
    expect(hasReceiptThumb({ thumbnailUrl: null, fileName: "x.jpg" })).toBe(false);
    expect(hasReceiptThumb({ thumbnailUrl: "/api/receipts/a/file/preview?w=160", fileName: "" })).toBe(true);
  });

  it("loads the thumbnail URL the paged row gives, else builds the same shape", () => {
    expect(receiptThumbSrc({ id: "a", thumbnailUrl: "/x?w=160" })).toBe("/x?w=160");
    expect(receiptThumbSrc({ id: "a", fileName: "x.jpg" })).toBe("/api/receipts/a/file/preview?w=160");
  });

  it("loads the large viewer copy only in full screen: the inline card uses the thumbnail", () => {
    expect(inlinePreviewSrc("/api/receipts/abc/file", "/api/receipts/abc/file/preview")).toBe(
      "/api/receipts/abc/file/preview?size=thumb"
    );
    expect(inlinePreviewSrc("/api/uploads/x.jpg", "/api/uploads/x.jpg")).toBe("/api/uploads/x.jpg");
  });
});
