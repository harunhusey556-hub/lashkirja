import { describe, expect, it } from "vitest";
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

const base = (overrides: Partial<InvoicePdfData> = {}): InvoicePdfData => ({
  number: 7,
  reference: createReferenceNumber("12345"),
  issueDate: "2026-01-15",
  dueDate: "2026-01-29",
  netCents: 10_000,
  vatCents: 2_550,
  grossCents: 12_550,
  breakdown: [{ ratePermille: 255, netCents: 10_000, vatCents: 2_550 }],
  seller: {
    name: "Liisan Ripsistudio",
    businessId: "0201256-6",
    addressStreet: "Kauppakatu 1",
    addressPostalCode: "00100",
    addressCity: "Helsinki",
    email: "liisa@example.fi",
    phone: "040 1234567",
    iban: "FI2112345600000785",
    bic: "NDEAFIHH",
    terms: null,
    vatRegistered: true,
  },
  customer: {
    name: "Anna Asiakas",
    businessId: null,
    email: "anna@example.fi",
    addressStreet: "Asiakastie 5",
    addressPostalCode: "00200",
    addressCity: "Espoo",
  },
  lines: [
    { description: "Ripsienpidennys", quantityMilli: 1_000, unit: "kpl", unitPriceCents: 10_000, vatRatePermille: 255, netCents: 10_000 },
  ],
  ...overrides,
});

describe("a draft invoice PDF says it is a draft (M2-4)", () => {
  it("prints LUONNOS on a draft and nothing of the kind on an issued invoice", async () => {
    expect(await extractText(await renderInvoicePdf(base({ draft: true })))).toContain("LUONNOS");
    expect(await extractText(await renderInvoicePdf(base()))).not.toContain("LUONNOS");
  });

  it("still prints the whole invoice around the mark", async () => {
    const text = await extractText(await renderInvoicePdf(base({ draft: true })));
    expect(text).toContain("Anna Asiakas");
    expect(text).toContain("125,50 €");
  });
});
