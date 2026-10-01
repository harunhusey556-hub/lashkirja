import { describe, expect, it, vi } from "vitest";

// No Unicode font on disk: the PDF must still never print garbage.
vi.mock("./pdf-fonts", () => ({ pdfFontFiles: () => null, resetPdfFontCache: () => {} }));

import { renderInvoicePdf, type InvoicePdfData } from "./invoice-pdf";
import { createReferenceNumber } from "./finnish-reference";

async function extractText(pdf: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(pdf) });
  try {
    return (await parser.getText()).text.replace(/\s+/g, " ");
  } finally {
    await parser.destroy();
  }
}

const data = (): InvoicePdfData => ({
  number: 1,
  reference: createReferenceNumber("12345"),
  issueDate: "2026-01-15",
  dueDate: "2026-01-29",
  notes: "Huom \u0141\u00f3d\u017a \t\u0007 \u{1F600} loppu",
  netCents: 10_000,
  vatCents: 0,
  grossCents: 10_000,
  breakdown: [{ ratePermille: 0, netCents: 10_000, vatCents: 0 }],
  seller: { name: "Liisa", vatRegistered: false },
  customer: { name: "\u015e\u00fckr\u00fc \u0418\u0432\u0430\u043d" },
  lines: [
    {
      description: "\u0141ukasz \u0151\u0171 \u05e9\u05dc\u05d5\u05dd",
      quantityMilli: 1_000,
      unit: "kpl",
      unitPriceCents: 10_000,
      vatRatePermille: 0,
      netCents: 10_000,
    },
  ],
});

describe("renderInvoicePdf without the Unicode font", () => {
  it("maps letters to their closest plain form and never prints garbage", async () => {
    const pdf = await renderInvoicePdf(data());
    const text = await extractText(pdf);
    expect(text).toContain("Huom Lódz ? loppu");
    expect(text).toContain("Sükrü ?");
    expect(text).toContain("Lukasz ou ?");
    expect(text).toContain("100,00 €");
    // Every string written with the built-in font is whole bytes.
    for (const hex of pdf.toString("latin1").matchAll(/<([0-9a-fA-F]+)>\s*(?:Tj|TJ)/g)) {
      expect(hex[1].length % 2).toBe(0);
    }
  });
});
