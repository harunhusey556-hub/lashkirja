import { describe, expect, it } from "vitest";
import { cleanMessage, cleanSubject, renderPlaceholders, type PlaceholderValues } from "./invoice-email-templates";
import { invoicePlaceholderValues } from "./invoice-mail";

const values: PlaceholderValues = {
  asiakas: "Anna",
  laskunumero: "12",
  summa: "125,50 €",
  erapaiva: "29.1.2026",
  viitenumero: "12 3",
  tilinumero: "FI21 1234",
  yritys: "Liisan Ripset",
};

describe("renderPlaceholders", () => {
  it("fills every known placeholder, in any letter case", () => {
    expect(renderPlaceholders("{asiakas} {LASKUNUMERO} {Summa} {erapaiva} {viitenumero} {tilinumero} {yritys}", values)).toBe(
      "Anna 12 125,50 € 29.1.2026 12 3 FI21 1234 Liisan Ripset"
    );
  });

  it("leaves unknown braces and a lone brace as typed", () => {
    expect(renderPlaceholders("{nimi} { asiakas } {asiakas", values)).toBe("{nimi} { asiakas } {asiakas");
  });

  it("does not fill a placeholder that a value brings in", () => {
    expect(renderPlaceholders("{asiakas}", { ...values, asiakas: "{yritys}" })).toBe("{yritys}");
  });
});

describe("cleaners", () => {
  it("keeps the subject on one line", () => {
    expect(cleanSubject("  Lasku\r\n12\tok\u0000  ")).toBe("Lasku 12 ok");
  });

  it("keeps the message's line breaks and drops other control characters", () => {
    expect(cleanMessage("Hei\r\n\r\nrivi\u0007\tsarake\rloppu \n")).toBe("Hei\n\nrivi\tsarake\nloppu");
  });
});

describe("invoicePlaceholderValues", () => {
  it("has nothing to pay against on a credit note", () => {
    const filled = invoicePlaceholderValues({
      number: 7,
      gross: -10,
      dueDate: "2026-01-29",
      reference: "74",
      iban: null,
      sellerName: "S",
      customerName: "C",
      creditNote: true,
    });
    expect(filled.erapaiva).toBe("–");
    expect(filled.viitenumero).toBe("–");
    expect(filled.tilinumero).toBe("–");
  });
});
