import { describe, expect, it } from "vitest";
import { renderInvoicePdf, type InvoicePdfData } from "./invoice-pdf";
import { createReferenceNumber } from "./finnish-reference";
import { buildBankBarcode } from "./bank-barcode";
import { formatReference } from "./finnish-reference";

const REFERENCE = createReferenceNumber("12345");
const IBAN = "FI2112345600000785";

async function extractText(pdf: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(pdf) });
  try {
    // pdfkit lays text out in columns, so collapse whitespace before matching.
    return (await parser.getText()).text.replace(/\s+/g, " ");
  } finally {
    await parser.destroy();
  }
}

const data = (overrides: Partial<InvoicePdfData> = {}): InvoicePdfData => ({
  number: 7,
  reference: REFERENCE,
  issueDate: "2026-01-15",
  dueDate: "2026-01-29",
  notes: "Kiitos kaupasta!",
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
    iban: IBAN,
    bic: "NDEAFIHH",
    terms: "Viivästyskorko 8 %.",
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
    {
      description: "Ripsienpidennys",
      quantityMilli: 1_000,
      unit: "kpl",
      unitPriceCents: 10_000,
      vatRatePermille: 255,
      netCents: 10_000,
    },
  ],
  ...overrides,
});

describe("renderInvoicePdf", () => {
  it("produces a real PDF file", async () => {
    const pdf = await renderInvoicePdf(data());
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(pdf.length).toBeGreaterThan(1000);
  });

  it("contains the parties, the amounts and the payment details", async () => {
    const text = await extractText(await renderInvoicePdf(data()));

    expect(text).toContain("LASKU");
    expect(text).toContain("Liisan Ripsistudio");
    expect(text).toContain("Anna Asiakas");
    expect(text).toContain("Ripsienpidennys");
    expect(text).toContain("125,50 €");
    expect(text).toContain("100,00 €");
    expect(text).toContain("25,50 €");
    expect(text).toContain("0201256-6");
    expect(text).toContain("FI21 1234 5600 0007 85");
    expect(text).toContain("NDEAFIHH");
    expect(text).toContain("Kiitos kaupasta!");
    expect(text).toContain("Viivästyskorko 8 %.");
  });

  it("keeps Finnish characters intact", async () => {
    const text = await extractText(await renderInvoicePdf(data()));
    expect(text).toContain("Eräpäivä");
    expect(text).toContain("Määrä");
    expect(text).toContain("Veroton yhteensä");
  });

  it("prints Finnish dates and the grouped reference", async () => {
    const text = await extractText(await renderInvoicePdf(data()));
    expect(text).toContain("15.1.2026");
    expect(text).toContain("29.1.2026");
    expect(text).toContain(formatReference(REFERENCE));
  });

  it("prints a bank barcode that decodes back to the invoice", async () => {
    const invoice = data();
    const text = await extractText(await renderInvoicePdf(invoice));
    const expected = buildBankBarcode({
      iban: IBAN,
      reference: REFERENCE,
      amountCents: invoice.grossCents,
      dueDate: `${invoice.dueDate}T00:00:00.000Z`,
    })!;
    expect(text.replace(/\s/g, "")).toContain(expected);
  });

  it("omits the barcode when there is no IBAN to pay into", async () => {
    const text = await extractText(
      await renderInvoicePdf(data({ seller: { ...data().seller, iban: null, bic: null } }))
    );
    expect(text).not.toContain("Virtuaaliviivakoodi");
    expect(text).toContain("Anna Asiakas");
  });

  it("states the VAT exemption for a seller who is not registered", async () => {
    const text = await extractText(
      await renderInvoicePdf(
        data({
          seller: { ...data().seller, vatRegistered: false },
          breakdown: [{ ratePermille: 0, netCents: 10_000, vatCents: 0 }],
          vatCents: 0,
          grossCents: 10_000,
        })
      )
    );
    expect(text).toContain("Ei arvonlisäverovelvollinen");
  });

  it("lists several rates and survives a long line list", async () => {
    const lines = Array.from({ length: 40 }, (_, index) => ({
      description: `Rivi ${index + 1} pitkällä kuvauksella joka voi rivittyä useammalle riville`,
      quantityMilli: 1_500,
      unit: "h",
      unitPriceCents: 5_000,
      vatRatePermille: index % 2 === 0 ? 255 : 140,
      netCents: 7_500,
    }));
    const pdf = await renderInvoicePdf(
      data({
        lines,
        breakdown: [
          { ratePermille: 255, netCents: 150_000, vatCents: 38_250 },
          { ratePermille: 140, netCents: 150_000, vatCents: 21_000 },
        ],
        netCents: 300_000,
        vatCents: 59_250,
        grossCents: 359_250,
      })
    );
    const text = await extractText(pdf);
    expect(text).toContain("Rivi 1");
    expect(text).toContain("Rivi 40");
    expect(text).toContain("ALV 25,5 %");
    expect(text).toContain("ALV 14 %");
    // Finnish grouping: the non-breaking space is collapsed by extractText.
    expect(text).toContain("3 592,50 €");
  });
});
