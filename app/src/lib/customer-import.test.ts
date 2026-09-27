import { describe, expect, it } from "vitest";
import { parseCustomerCsv } from "./customer-import";

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
});
