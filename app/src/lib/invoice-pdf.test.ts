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
          lines: [{ ...data().lines[0], vatRatePermille: 0 }],
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

const creditNote = (overrides: Partial<InvoicePdfData> = {}): InvoicePdfData =>
  data({
    documentKind: "credit_note",
    originalNumber: 7,
    number: 18,
    netCents: -5_140,
    vatCents: -1_310,
    grossCents: -6_450,
    breakdown: [{ ratePermille: 255, netCents: -5_140, vatCents: -1_310 }],
    lines: [
      {
        description: "Ripsienpidennys",
        quantityMilli: 1_000,
        unit: "kpl",
        unitPriceCents: -5_140,
        vatRatePermille: 255,
        netCents: -5_140,
      },
    ],
    ...overrides,
  });

describe("renderInvoicePdf: credit note (F02, G01)", () => {
  it("prints negative amounts with a minus sign, never a quotation mark", async () => {
    const pdf = await renderInvoicePdf(creditNote());
    const text = await extractText(pdf);
    expect(text).toContain("HYVITYSLASKU");
    expect(text).toContain("-64,50 €");
    expect(text).toContain("-51,40 €");
    expect(text).toContain("-13,10 €");
    expect(text).not.toContain('"');
    // pdfkit writes an unmapped U+2212 as the hex digits 2212.
    expect(pdf.toString("latin1")).not.toContain("<2212");
  });

  it("does not present itself as payable", async () => {
    const text = await extractText(await renderInvoicePdf(creditNote()));
    expect(text).not.toContain("Maksutiedot");
    expect(text).not.toContain("Summa:");
    expect(text).not.toContain("Eräpäivä");
    expect(text).not.toContain("Virtuaaliviivakoodi");
    expect(text).not.toContain(IBAN.slice(0, 4) + " ");
    expect(text).toContain("Tämä on hyvityslasku");
    expect(text).toContain("laskun 7");
  });

  it("prints no negative zero on a 0 % row", async () => {
    const text = await extractText(
      await renderInvoicePdf(
        creditNote({
          seller: { ...data().seller, vatRegistered: true },
          breakdown: [
            { ratePermille: 255, netCents: -5_140, vatCents: -1_310 },
            { ratePermille: 0, netCents: -1_000, vatCents: -0 },
          ],
        })
      )
    );
    expect(text).not.toMatch(/-0,00/);
  });
});

describe("renderInvoicePdf: text the font may not know (F02)", () => {
  const hostile = () =>
    data({
      notes: "Huom: \u0141\u00f3d\u017a \u0151\u0171 \u017e \t\u0007loppu",
      customer: {
        ...data().customer,
        name: "\u015e\u00fckr\u00fc A\u011fao\u011flu \u0130n\u015faat",
      },
      lines: [
        {
          description: "\u0141ukasz \u017b\u00f3\u0142\u0107 \u0418\u0432\u0430\u043d \u041f\u0435\u0442\u0440\u043e\u0432 \u{1F600}",
          quantityMilli: 1_000,
          unit: "kpl",
          unitPriceCents: 10_000,
          vatRatePermille: 255,
          netCents: 10_000,
        },
      ],
    });

  it("keeps the next column readable and drops control characters", async () => {
    const pdf = await renderInvoicePdf(hostile());
    const text = await extractText(pdf);
    // The amounts after the description are still in place.
    expect(text).toContain("100,00 €");
    expect(text).toContain("125,50 €");
    expect(text).not.toContain("\u0007");
    expect(text).toContain("loppu");
    // No unpaired hex digit from an unmapped code point inside a string.
    expect(pdf.toString("latin1")).not.toMatch(/<[0-9a-f]*[0-9a-f]{1}>\s*Tj/i);
  });

  it("draws Latin Extended and Cyrillic as typed when the Unicode font is available", async () => {
    const text = await extractText(await renderInvoicePdf(hostile()));
    expect(text).toContain("\u015e\u00fckr\u00fc A\u011fao\u011flu \u0130n\u015faat");
    expect(text).toContain("\u0141ukasz \u017b\u00f3\u0142\u0107");
    expect(text).toContain("\u0418\u0432\u0430\u043d \u041f\u0435\u0442\u0440\u043e\u0432");
  });
});

describe("renderInvoicePdf: VAT and a seller who is not registered (F01)", () => {
  const plainLine = {
    description: "Ripsienpidennys",
    quantityMilli: 1_000,
    unit: "kpl",
    unitPriceCents: 10_000,
    vatRatePermille: 0,
    netCents: 10_000,
  };

  it("prints no VAT column or breakdown and states the exemption", async () => {
    const text = await extractText(
      await renderInvoicePdf(
        data({
          seller: { ...data().seller, vatRegistered: false },
          lines: [plainLine],
          breakdown: [{ ratePermille: 0, netCents: 10_000, vatCents: 0 }],
          vatCents: 0,
          grossCents: 10_000,
        })
      )
    );
    expect(text).toContain("Ei arvonlisäverovelvollinen (AVL 3 §)");
    expect(text).not.toMatch(/ALV/);
    expect(text).not.toContain("Veroton");
    expect(text).toContain("100,00 €");
  });

  it("never claims the exemption next to VAT that was charged", async () => {
    const text = await extractText(
      await renderInvoicePdf(data({ seller: { ...data().seller, vatRegistered: false } }))
    );
    expect(text).not.toContain("Ei arvonlisäverovelvollinen");
    expect(text).toContain("ALV 25,5 %");
    expect(text).toContain("125,50 €");
  });

  it("keeps the VAT columns for a registered seller", async () => {
    const text = await extractText(await renderInvoicePdf(data()));
    expect(text).toContain("ALV");
    expect(text).not.toContain("Ei arvonlisäverovelvollinen");
  });
});
