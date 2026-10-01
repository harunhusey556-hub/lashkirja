import { describe, expect, it } from "vitest";
import { CustomerCsvFileError, parseCustomerCsv } from "./customer-import";

describe("parseCustomerCsv", () => {
  it("reports a bad email and a bad business id without dropping the other row", () => {
    const rows = parseCustomerCsv(
      ["nimi,sähköposti,puhelin,y-tunnus", "Anna,anna@example.fi,040,0201256-6", "Bob,ei-osoite,,"].join(
        "\n"
      )
    );
    expect(rows[0]).toMatchObject({ name: "Anna", email: "anna@example.fi", errors: [] });
    expect(rows[1].errors.join(" ")).toContain("Sähköposti");
    expect(rows[0].businessId).toBe("0201256-6");
  });

  it("flags a repeated name and a missing name", () => {
    const rows = parseCustomerCsv("Anna\nAnna\n");
    expect(rows[1].errors.join(" ")).toContain("Sama nimi");
    const blank = parseCustomerCsv(",bob@example.fi");
    expect(blank[0].errors.join(" ")).toContain("Nimi puuttuu");
  });

  it("reads a semicolon file with BOM and CRLF, the header row is never a customer", () => {
    const rows = parseCustomerCsv(
      "\uFEFFNimi;Y-tunnus;Sähköposti\r\nLT a;0201256-6;a@example.fi\r\nLT b;;\r\n"
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ name: "LT a", businessId: "0201256-6", email: "a@example.fi", errors: [] });
    expect(rows[1]).toMatchObject({ name: "LT b", errors: [], line: 3 });
  });

  it("reads a tab separated file", () => {
    const rows = parseCustomerCsv("Nimi\tPuhelin\nAnna\t040 123");
    expect(rows[0]).toMatchObject({ name: "Anna", phone: "040 123" });
  });

  it("keeps a quoted line break and a quoted separator inside one cell", () => {
    const rows = parseCustomerCsv('Nimi;Puhelin\n"Oy; Ab\nPääkonttori";040\n');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Oy; Ab\nPääkonttori");
    expect(rows[0].phone).toBe("040");
  });

  it("refuses a header row without a Nimi column instead of importing it as a customer", () => {
    expect(() => parseCustomerCsv("Yritys;Y-tunnus;Sähköposti\nA;;")).toThrow(CustomerCsvFileError);
  });
});
