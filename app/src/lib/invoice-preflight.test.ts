import { describe, expect, it } from "vitest";
import { sellerPreflight } from "./invoice-preflight";

describe("the new-invoice page names a missing IBAN before the invoice exists (F22)", () => {
  it("asks for the seller details when the account has no IBAN", () => {
    for (const invoiceIban of [null, "", "   "]) {
      expect(sellerPreflight({ invoiceIban })?.title).toBe("Täydennä laskuttajan tiedot");
    }
    expect(sellerPreflight({ invoiceIban: null })?.body).toContain("tilinumero");
  });

  it("is silent with an IBAN, with no profile yet, and with a profile that does not carry the field", () => {
    expect(sellerPreflight({ invoiceIban: "FI2112345600000785" })).toBeNull();
    expect(sellerPreflight(null)).toBeNull();
    expect(sellerPreflight({})).toBeNull();
  });
});
