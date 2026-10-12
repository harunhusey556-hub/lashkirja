import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// vi.mock is hoisted above the imports, so the factory loads React itself.
vi.mock("next/link", async () => {
  const react = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
      react.createElement("a", { href, ...rest }, children as never),
  };
});

import { OstolaskuNoticeView, type OstolaskuView } from "./OstolaskuNotice";

const filed: OstolaskuView = {
  documentType: "invoice",
  purchaseInvoice: { id: "inv-1", status: "open", displayStatus: "open", dueDate: "2026-02-24", dueDateAssumed: true },
};

const html = (view: OstolaskuView) =>
  renderToStaticMarkup(createElement(OstolaskuNoticeView, { view, busy: false, onSetKind: () => {} }));

describe("OstolaskuNoticeView", () => {
  it("says the receipt is an ostolasku, with its due date marked as assumed, and links to it", () => {
    const out = html(filed);
    expect(out).toContain("Tämä on ostolasku");
    expect(out).toContain("Eräpäivä 24.2.2026 (oletus)");
    expect(out).toContain('href="/kirjanpito/ostolaskut?id=inv-1"');
    expect(out).toContain("Avaa ostolasku");
    expect(out).toContain("Ei ole lasku");
  });

  it("drops the oletus mark once the due date is the bill's own, and offers no undo on a paid one", () => {
    const out = html({
      ...filed,
      purchaseInvoice: { ...filed.purchaseInvoice!, status: "paid", displayStatus: "paid", dueDateAssumed: false },
    });
    expect(out).toContain("Eräpäivä 24.2.2026 · Maksettu");
    expect(out).not.toContain("oletus");
    expect(out).not.toContain("Ei ole lasku");
  });

  it("offers Merkitse ostolaskuksi on a plain kuitti and on one whose ostolasku was cancelled", () => {
    expect(html({ documentType: "receipt", purchaseInvoice: null })).toContain("Merkitse ostolaskuksi");
    const cancelled = html({ ...filed, purchaseInvoice: { ...filed.purchaseInvoice!, status: "cancelled", displayStatus: "cancelled" } });
    expect(cancelled).toContain("Ostolasku on peruttu, tämä on kuitti.");
    expect(cancelled).not.toContain("Tämä on ostolasku");
  });
});
