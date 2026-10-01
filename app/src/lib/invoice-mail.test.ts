import { describe, expect, it } from "vitest";
import { defaultMessage } from "./invoice-mail";

const base = {
  number: 213,
  gross: "-127,25 €",
  dueDate: "2026-10-01",
  reference: "2134",
  sellerName: "Liisa",
};

describe("defaultMessage", () => {
  it("asks for payment on an invoice", () => {
    const text = defaultMessage(base);
    expect(text).toContain("Eräpäivä: 2026-10-01");
    expect(text).toContain("Viitenumero: 2134");
  });

  it("does not ask for payment on a credit note (V5)", () => {
    const text = defaultMessage({ ...base, creditNote: true });
    expect(text).toContain("hyvityslasku 213");
    expect(text).not.toContain("Eräpäivä");
    expect(text).not.toContain("Viitenumero");
    expect(text).toContain("ei maksettava lasku");
  });
});
