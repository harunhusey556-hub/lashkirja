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

import {
  PurchaseMatchList,
  isSureSuggestion,
  purchaseMatchRows,
  type OpenPurchase,
  type PaymentSuggestion,
} from "./PurchaseMatchList";
import PurchaseMatchPage from "./page";

const INVOICES: OpenPurchase[] = [
  { id: "a", supplierName: "Vuokra Oy", invoiceNumber: "77", dueDate: "2026-10-20", displayStatus: "open", open: 950 },
  { id: "b", supplierName: "Kampaamotukku Oy", invoiceNumber: null, dueDate: "2026-09-01", displayStatus: "overdue", open: 100.5 },
  { id: "c", supplierName: "Maksettu Oy", invoiceNumber: null, dueDate: "2026-08-01", displayStatus: "paid", open: 0 },
];

const SUGGESTION: PaymentSuggestion = {
  invoiceId: "a",
  transactionId: "t1",
  amount: 950,
  paidDate: "2026-10-18",
  counterparty: "VUOKRA OY",
  score: 0.88,
  reasons: ["summa sama", "nimi vastaa"],
};

const noop = () => {};

describe("purchaseMatchRows", () => {
  it("lists open and overdue ostolaskut, proposals first", () => {
    const rows = purchaseMatchRows(INVOICES, [SUGGESTION]);
    expect(rows.map((row) => [row.invoice.id, row.suggestion?.transactionId ?? null])).toEqual([
      ["a", "t1"],
      ["b", null],
    ]);
  });

  it("calls only strong matches sure", () => {
    expect(isSureSuggestion(SUGGESTION)).toBe(true);
    expect(isSureSuggestion({ ...SUGGESTION, score: 0.72 })).toBe(false);
  });
});

describe("PurchaseMatchList", () => {
  it("shows each proposal with the bank payment and Hyväksy / Hylkää, and the rest without one", () => {
    const html = renderToStaticMarkup(
      createElement(PurchaseMatchList, {
        rows: purchaseMatchRows(INVOICES, [SUGGESTION]),
        busyId: null,
        onAccept: noop,
        onReject: noop,
      })
    );
    expect(html).toContain("Ehdotetut maksut");
    expect(html).toContain("Vuokra Oy");
    expect(html).toContain("Pankki · VUOKRA OY · 18.10.2026");
    expect(html).toContain("summa sama, nimi vastaa · varma");
    expect(html).toContain(">Hyväksy<");
    expect(html).toContain(">Hylkää<");
    expect(html).toContain("Ei maksuehdotusta");
    expect(html).toContain("Myöhässä, eräpäivä 1.9.");
    // A row without a proposal opens that ostolasku, not the list (W27).
    expect(html).toContain('href="/kirjanpito/ostolaskut?id=b"');
    expect(html).not.toContain("Maksettu Oy");
  });

  it("disables the buttons of the row being written", () => {
    const html = renderToStaticMarkup(
      createElement(PurchaseMatchList, {
        rows: purchaseMatchRows(INVOICES, [SUGGESTION]),
        busyId: "a",
        onAccept: noop,
        onReject: noop,
      })
    );
    expect(html.match(/disabled=""/g)?.length).toBe(2);
  });
});

describe("Kohdista ostolaskujen maksut page", () => {
  it("renders its title and a loading list before the data arrives", () => {
    const html = renderToStaticMarkup(createElement(PurchaseMatchPage));
    expect(html).toContain("Kohdista ostolaskujen maksut");
    expect(html).toContain("Ladataan");
  });
});
