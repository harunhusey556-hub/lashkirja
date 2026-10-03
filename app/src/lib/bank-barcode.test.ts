import { describe, expect, it } from "vitest";
import {
  BARCODE_LENGTH,
  buildBankBarcode,
  decodeBankBarcode,
  formatBankBarcode,
  MAX_BARCODE_CENTS,
} from "./bank-barcode";
import { createReferenceNumber } from "./finnish-reference";

const IBAN = "FI2112345600000785";
const REFERENCE = createReferenceNumber("123456"); // 1234561

describe("buildBankBarcode", () => {
  it("produces 54 digits starting with the version", () => {
    const barcode = buildBankBarcode({
      iban: IBAN,
      reference: REFERENCE,
      amountCents: 125_50,
      dueDate: "2026-02-15",
    })!;
    expect(barcode).toHaveLength(BARCODE_LENGTH);
    expect(barcode[0]).toBe("4");
    expect(/^\d+$/.test(barcode)).toBe(true);
  });

  it("places every field where the standard expects it", () => {
    const barcode = buildBankBarcode({
      iban: IBAN,
      reference: REFERENCE,
      amountCents: 4_883_15,
      dueDate: "2026-06-12",
    })!;

    expect(barcode.slice(1, 17)).toBe("2112345600000785"); // IBAN without "FI"
    expect(barcode.slice(17, 23)).toBe("004883"); // euros
    expect(barcode.slice(23, 25)).toBe("15"); // cents
    expect(barcode.slice(25, 28)).toBe("000"); // reserved
    expect(barcode.slice(28, 48)).toBe("00000000000001234561"); // reference, padded
    expect(barcode.slice(48, 54)).toBe("260612"); // YYMMDD
  });

  it("round-trips through the decoder", () => {
    for (const amountCents of [0, 1, 99, 100, 125_50, MAX_BARCODE_CENTS]) {
      const barcode = buildBankBarcode({
        iban: IBAN,
        reference: REFERENCE,
        amountCents,
        dueDate: "2026-02-15",
      })!;
      expect(decodeBankBarcode(barcode)).toEqual({
        version: "4",
        iban: IBAN,
        amountCents,
        reference: REFERENCE,
        dueDate: "2026-02-15",
      });
    }
  });

  it("writes zeros when there is no due date", () => {
    const barcode = buildBankBarcode({
      iban: IBAN,
      reference: REFERENCE,
      amountCents: 100,
    })!;
    expect(barcode.slice(48)).toBe("000000");
    expect(decodeBankBarcode(barcode)?.dueDate).toBeNull();
  });

  it("refuses amounts the format cannot carry", () => {
    expect(
      buildBankBarcode({ iban: IBAN, reference: REFERENCE, amountCents: MAX_BARCODE_CENTS + 1 })
    ).toBeNull();
    expect(buildBankBarcode({ iban: IBAN, reference: REFERENCE, amountCents: -1 })).toBeNull();
    expect(buildBankBarcode({ iban: IBAN, reference: REFERENCE, amountCents: 10.5 })).toBeNull();
  });

  it("refuses a foreign or invalid IBAN", () => {
    expect(
      buildBankBarcode({
        iban: "DE89370400440532013000",
        reference: REFERENCE,
        amountCents: 100,
      })
    ).toBeNull();
    expect(
      buildBankBarcode({ iban: "FI2112345600000786", reference: REFERENCE, amountCents: 100 })
    ).toBeNull();
    expect(buildBankBarcode({ iban: "", reference: REFERENCE, amountCents: 100 })).toBeNull();
  });

  it("refuses an invalid or RF reference rather than encoding something wrong", () => {
    expect(buildBankBarcode({ iban: IBAN, reference: "1234562", amountCents: 100 })).toBeNull();
    expect(buildBankBarcode({ iban: IBAN, reference: "RF111234561", amountCents: 100 })).toBeNull();
    expect(buildBankBarcode({ iban: IBAN, reference: "", amountCents: 100 })).toBeNull();
  });

  it("accepts the printed IBAN and reference forms with spaces", () => {
    const barcode = buildBankBarcode({
      iban: "FI21 1234 5600 0007 85",
      reference: "12 34561",
      amountCents: 100,
    });
    expect(barcode).not.toBeNull();
    expect(decodeBankBarcode(barcode!)?.reference).toBe(REFERENCE);
  });

  it("handles a 20-digit reference without truncating it", () => {
    const long = createReferenceNumber("1".repeat(19));
    expect(long).toHaveLength(20);
    const barcode = buildBankBarcode({ iban: IBAN, reference: long, amountCents: 100 })!;
    expect(decodeBankBarcode(barcode)?.reference).toBe(long);
  });
});

describe("decodeBankBarcode", () => {
  it("rejects anything that is not 54 digits of version 4", () => {
    expect(decodeBankBarcode("")).toBeNull();
    expect(decodeBankBarcode("5".repeat(54))).toBeNull();
    expect(decodeBankBarcode("4".repeat(53))).toBeNull();
    expect(decodeBankBarcode(`4${"x".repeat(53)}`)).toBeNull();
  });

  it("tolerates the spaced print form", () => {
    const barcode = buildBankBarcode({
      iban: IBAN,
      reference: REFERENCE,
      amountCents: 125_50,
      dueDate: "2026-02-15",
    })!;
    expect(decodeBankBarcode(formatBankBarcode(barcode))?.amountCents).toBe(125_50);
  });
});

describe("formatBankBarcode", () => {
  it("groups in sixes without a trailing space", () => {
    const barcode = buildBankBarcode({
      iban: IBAN,
      reference: REFERENCE,
      amountCents: 100,
      dueDate: "2026-02-15",
    })!;
    const formatted = formatBankBarcode(barcode);
    expect(formatted.split(" ")).toHaveLength(9);
    expect(formatted).not.toMatch(/\s$/);
    expect(formatted.replace(/\s/g, "")).toBe(barcode);
  });
});

describe("barcodeIssue", () => {
  it("is null when the barcode can be made", async () => {
    const { barcodeIssue } = await import("./bank-barcode");
    expect(barcodeIssue({ iban: IBAN, reference: REFERENCE, amountCents: 100 })).toBeNull();
  });

  it("says why there is no barcode", async () => {
    const { barcodeIssue } = await import("./bank-barcode");
    expect(barcodeIssue({ iban: null, reference: REFERENCE, amountCents: 100 })).toBe(
      "Lisää yrityksen tilinumero (IBAN) asetuksiin, niin laskuun tulee virtuaaliviivakoodi."
    );
    expect(barcodeIssue({ iban: "SE4550000000058398257466", reference: REFERENCE, amountCents: 100 })).toBe(
      "Virtuaaliviivakoodi tehdään vain suomalaiselle tilinumerolle (FI)."
    );
    expect(barcodeIssue({ iban: IBAN, reference: "RF18539007547034", amountCents: 100 })).toBe(
      "RF-viitteelle ei tehdä virtuaaliviivakoodia; maksaja syöttää viitteen käsin."
    );
    expect(barcodeIssue({ iban: IBAN, reference: REFERENCE, amountCents: MAX_BARCODE_CENTS + 1 })).toBe(
      "Yli 999 999,99 euron summaa ei voi esittää virtuaaliviivakoodina."
    );
  });
});
