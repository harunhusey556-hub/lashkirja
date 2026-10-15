import { describe, expect, it } from "vitest";
import {
  creditSigned,
  creditSignedVatLines,
  enrichExtractedReceipt,
  namesCreditNote,
  normalizeAIResult,
  parseOCRText,
  type ExtractedReceipt,
} from "./ai";
import { autoAcceptBlock } from "./auto-accept";
import { vatLinesProblem } from "./receipt-vat";

/**
 * Item 5 of the owner wave: "Does the platform detect credit notes?" A credit
 * note (hyvityslasku) is recognised by the model, by the wording at the head of
 * the document and by a total printed negative; the reading keeps positive sizes
 * and the stored receipt is booked negative.
 */

// A Finnish supplier credit note as pdftotext -layout prints it: the total with its minus.
const FI_NEGATIVE = `
Tukku Oy                                         HYVITYSLASKU
Teollisuuskatu 5, 00510 Helsinki                 Laskun numero      H-77
Y-tunnus 1234567-8                               Päivämäärä         15.08.2026
                                                 Hyvitettävä lasku  1234

Palautettu tavara                     100,00     25,5 %     25,50     -125,50
Veroton yhteensä                                                    -100,00
ALV 25,5 %                                                           -25,50
Yhteensä                                                            -125,50 €
`;

// The same credit printed with a positive total: only the wording says it is a credit.
const FI_POSITIVE = `
Tukku Oy
Hyvitys
Päivämäärä 15.08.2026
Hyvitettävä lasku 1234
Palautettu tavara 100,00 25,5 % 25,50
Yhteensä 125,50 €
`;

const EN_CREDIT = `
Northwind Ltd
CREDIT NOTE CN-77
Date 2026-08-15
Original invoice INV-1234
Returned goods                 100.00
VAT 25.5%                       25.50
Total                          125.50 EUR
`;

const ORDINARY = `
K-Market Kamppi
Päivämäärä 15.08.2026
Maito 1,99
Alennus -0,50
Yhteensä 12,40 €
`;

describe("parseOCRText (local OCR fallback) recognises a credit note", () => {
  it("reads 'HYVITYSLASKU' with a negative total: a positive size, the credit flag, the original number", () => {
    const reading = parseOCRText(FI_NEGATIVE);
    expect(reading.isCreditNote).toBe(true);
    expect(reading.totalAmount).toBe(125.5);
    expect(reading.creditsInvoiceNumber).toBe("1234");
    expect(reading.notes).toMatch(/^Hyvityslasku: summa ja ALV kirjataan negatiivisina\./);
  });

  it("reads 'Hyvitys' with a positive total as a credit too", () => {
    const reading = parseOCRText(FI_POSITIVE);
    expect(reading.isCreditNote).toBe(true);
    expect(reading.totalAmount).toBe(125.5);
    expect(reading.creditsInvoiceNumber).toBe("1234");
  });

  it("reads an English 'Credit note' and its 'Original invoice INV-1234'", () => {
    const reading = parseOCRText(EN_CREDIT);
    expect(reading.isCreditNote).toBe(true);
    expect(reading.creditsInvoiceNumber).toBe("INV-1234");
  });

  it("takes a total printed negative as a credit even without the word", () => {
    expect(parseOCRText("Kauppa Oy\nYhteensä -24,90 €\n").isCreditNote).toBe(true);
    expect(parseOCRText("Kauppa Oy\nMaksettava 24,90-\n").isCreditNote).toBe(true);
  });

  it("leaves an ordinary receipt alone: a discount line is negative, the total is not", () => {
    const reading = parseOCRText(ORDINARY);
    expect(reading.isCreditNote).toBe(false);
    expect(reading.creditsInvoiceNumber).toBeNull();
    expect(reading.notes ?? "").not.toMatch(/Hyvityslasku/);
  });

  it("leaves a bill alone that only mentions credit notes in its terms further down", () => {
    const terms = `Tukku Oy\nLasku 1234\nYhteensä 125,50 €\n${"Maksuehdot ".repeat(50)}\nHyvityslasku annetaan palautuksista.`;
    expect(parseOCRText(terms).isCreditNote).toBe(false);
  });
});

describe("normalizeAIResult keeps a credit note's amount", () => {
  it("turns a negative total and VAT into sizes and the credit flag, instead of dropping the total", () => {
    const reading = normalizeAIResult(
      { vendor: "Tukku Oy", totalAmount: -125.5, vatDetails: [{ rate: 25.5, amount: -25.5 }], documentType: "lasku" },
      "openai-compatible"
    );
    expect(reading.totalAmount).toBe(125.5);
    expect(reading.vatDetails).toEqual([{ rate: 25.5, amount: 25.5 }]);
    expect(reading.isCreditNote).toBe(true);
  });

  it("takes the model's own isCreditNote and the number it read for the original", () => {
    const reading = normalizeAIResult(
      { vendor: "Tukku Oy", totalAmount: 125.5, isCreditNote: true, invoiceNumber: "H-77", creditsInvoiceNumber: "1234" },
      "openai-compatible"
    );
    expect(reading).toMatchObject({ isCreditNote: true, invoiceNumber: "H-77", creditsInvoiceNumber: "1234", totalAmount: 125.5 });
  });

  it("drops an original number on a reading that is not a credit", () => {
    const reading = normalizeAIResult({ totalAmount: 10, creditsInvoiceNumber: "1234" }, "openai-compatible");
    expect(reading.isCreditNote).toBe(false);
    expect(reading.creditsInvoiceNumber).toBeNull();
  });
});

describe("the post-parse check does not rely on the model alone", () => {
  const modelSaidNo: ExtractedReceipt = {
    ...normalizeAIResult({ vendor: "Tukku Oy", date: "2026-08-15", totalAmount: 125.5, isCreditNote: false }, "openai-compatible"),
    rawText: FI_NEGATIVE,
  };

  it("marks the reading a credit note when the text heading says HYVITYSLASKU", () => {
    const reading = enrichExtractedReceipt(modelSaidNo);
    expect(reading.isCreditNote).toBe(true);
    expect(reading.creditsInvoiceNumber).toBe("1234");
  });

  it("is idempotent: the note is written once", () => {
    const twice = enrichExtractedReceipt(enrichExtractedReceipt(modelSaidNo));
    expect(twice.notes?.match(/Hyvityslasku:/g)).toHaveLength(1);
  });

  it("names a credit note from the head of the text, the notes or the file name", () => {
    expect(namesCreditNote({ rawText: "KREDITNOTA 5" })).toBe(true);
    expect(namesCreditNote({ rawText: "Kreditfaktura nr 5" })).toBe(true);
    expect(namesCreditNote({ notes: "Credit memo for order 7" })).toBe(true);
    expect(namesCreditNote({ fileName: "credit_note_77.pdf" })).toBe(true);
    expect(namesCreditNote({ rawText: "Lasku 1234\nYhteensä 10,00" })).toBe(false);
    // "hyvityksen" is a word about credits, not a credit note's heading.
    expect(namesCreditNote({ rawText: "Pyydä hyvityksen ehdot asiakaspalvelusta" })).toBe(false);
  });
});

describe("creditSigned: a credit note is booked negative however it was printed", () => {
  it("makes '-124,00' and '124,00 Hyvitys' both -12400", () => {
    expect(creditSigned(-12_400, true)).toBe(-12_400);
    expect(creditSigned(12_400, true)).toBe(-12_400);
    expect(creditSigned(12_400, false)).toBe(12_400);
    expect(creditSigned(12_400, undefined)).toBe(12_400);
    expect(Object.is(creditSigned(0, true), 0)).toBe(true);
  });

  it("makes every VAT line negative, and leaves an ordinary reading's lines as they are", () => {
    expect(creditSignedVatLines([{ rate: 25.5, amount: 25.5 }, { rate: 14, amount: -1.4 }], true)).toEqual([
      { rate: 25.5, amount: -25.5 },
      { rate: 14, amount: -1.4 },
    ]);
    const lines = [{ rate: 25.5, amount: 25.5 }];
    expect(creditSignedVatLines(lines, false)).toBe(lines);
  });
});

describe("a credit note is never approved blind", () => {
  it("waits for the owner with its own reason, even though the reading shows a positive size", () => {
    const complete = {
      vendor: "Tukku Oy",
      date: "2026-08-15",
      totalAmount: 125.5,
      confidence: 0.9,
      source: "ai",
      documentType: "invoice",
    };
    expect(autoAcceptBlock(complete)).toBeNull();
    expect(autoAcceptBlock({ ...complete, isCreditNote: true })).toBe("credit_note");
  });
});

describe("vatLinesProblem holds a credit note's negative VAT to its negative total", () => {
  it("accepts VAT inside the total and refuses more, by size", () => {
    expect(vatLinesProblem([{ rate: 25.5, amount: -25.5 }], -125.5)).toBeNull();
    expect(vatLinesProblem([{ rate: 25.5, amount: -130 }], -125.5)).not.toBeNull();
    expect(vatLinesProblem([{ rate: 25.5, amount: 130 }], 125.5)).not.toBeNull();
  });
});
