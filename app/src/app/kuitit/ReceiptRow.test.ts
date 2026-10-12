import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReceiptRow } from "./ReceiptRow";
import type { SavedReceipt } from "./types";

const receipt: SavedReceipt = {
  id: "r1",
  vendor: "Kahvila Oy",
  date: "2026-09-10T00:00:00.000Z",
  totalAmount: 12.5,
  category: null,
  type: "meno",
  reference: null,
  invoiceNumber: null,
  fileName: "kuitti.jpg",
  source: "ai",
  createdAt: "2026-09-10T00:00:00.000Z",
  match: { status: "unlinked", suggestedTransaction: null, matchCandidates: [] } as unknown as SavedReceipt["match"],
};

describe("ReceiptRow", () => {
  it("is memoised, so an unrelated state change in the list repaints no row", () => {
    expect((ReceiptRow as unknown as { $$typeof: symbol }).$$typeof).toBe(Symbol.for("react.memo"));
  });

  it("renders the vendor and a tile, and never an <img> before the row is near the screen", () => {
    const out = renderToStaticMarkup(
      createElement(ReceiptRow, { receipt, selected: false, onToggleSelect: () => {} })
    );
    expect(out).toContain("Kahvila Oy");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("/file/preview");
  });
});
