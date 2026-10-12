import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// vi.mock is hoisted above the imports, so the factories load React themselves.
vi.mock("next/link", async () => {
  const react = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
      react.createElement("a", { href, ...rest }, children as never),
  };
});

import { ReceiptApprovalSheet, type ApprovalSheetReceipt } from "./ReceiptApprovalSheet";

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);

const RECEIPT: ApprovalSheetReceipt = {
  receiptId: "8f1c2b0e-1111-4222-8333-444455556666",
  party: "Kahvila Oy",
  amount: 12.5,
  type: "meno",
  date: "2026-09-01",
  category: "tarjoilu",
  vatRate: 14,
  gaps: [],
  fileName: "kahvila.pdf",
};

describe("ReceiptApprovalSheet (B)", () => {
  it("shows the receipt beside the fields the AI read, and keeps the viewer", () => {
    const out = html(
      createElement(ReceiptApprovalSheet, {
        receipt: RECEIPT,
        onClose: () => {},
        onApprove: () => {},
        onEdit: () => {},
      })
    );
    // The rendered variant answers an image for a photo, a PDF page or HEIC.
    expect(out).toContain(`/api/receipts/${RECEIPT.receiptId}/file/preview`);
    expect(out).toContain("Koko näyttö");
    expect(out).toContain("Summa");
    expect(out).toContain("12,50");
    expect(out).toContain("Hyväksy");
  });

  it("still asks for the gap instead of approving, and still previews the document", () => {
    const out = html(
      createElement(ReceiptApprovalSheet, {
        receipt: { ...RECEIPT, amount: null, gaps: ["amount", "vendor"] },
        onClose: () => {},
        onApprove: () => {},
        onEdit: () => {},
      })
    );
    expect(out).toContain(`/api/receipts/${RECEIPT.receiptId}/file/preview`);
    expect(out).toContain("Lisää summa ja myyjä");
    expect(out).toContain("Täydennä kuitti");
  });

  it("renders nothing at all when no receipt is targeted", () => {
    const out = html(
      createElement(ReceiptApprovalSheet, {
        receipt: null,
        onClose: () => {},
        onApprove: () => {},
        onEdit: () => {},
      })
    );
    expect(out).toBe("");
  });
});
