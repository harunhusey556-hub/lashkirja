import { describe, expect, it } from "vitest";
import {
  sellerBlankedErrors,
  sellerSavedText,
  sellerUnchanged,
  type SellerFormValues,
} from "./seller-form";

const EMPTY: SellerFormValues = {
  businessName: "",
  businessId: "",
  addressStreet: "",
  addressPostalCode: "",
  addressCity: "",
  phone: "",
  invoiceIban: "",
  invoiceBic: "",
  invoiceTerms: "",
  lateInterestPercent: "",
  reminderFeeCents: "5,00",
};
const FULL: SellerFormValues = {
  ...EMPTY,
  businessName: "Liisan Ripsistudio",
  businessId: "0201256-6",
  invoiceIban: "FI21 1234 5600 0007 85",
};

describe("seller form rules (F23)", () => {
  it("an untouched empty form is unchanged, so nothing is saved or claimed", () => {
    expect(sellerUnchanged(EMPTY, EMPTY)).toBe(true);
    expect(sellerUnchanged({ ...EMPTY, businessName: "  " }, EMPTY)).toBe(true);
    expect(sellerUnchanged({ ...FULL, invoiceIban: "fi2112345600000785" }, FULL)).toBe(true);
    expect(sellerUnchanged({ ...FULL, phone: "040" }, FULL)).toBe(false);
  });

  it("refuses to blank a saved name, Y-tunnus or IBAN", () => {
    const errors = sellerBlankedErrors(EMPTY, FULL);
    expect(Object.keys(errors).sort()).toEqual(["businessId", "businessName", "invoiceIban"]);
    expect(sellerBlankedErrors(EMPTY, EMPTY)).toEqual({});
  });

  it("says what is still missing instead of a plain 'saved'", () => {
    expect(sellerSavedText(FULL)).toBe("Laskuttajan tiedot tallennettu.");
    expect(sellerSavedText({ ...EMPTY, reminderFeeCents: "7,00" })).toBe(
      "Tallennettu. Laskun lähettämiseen tarvitaan vielä nimi, Y-tunnus ja tilinumero."
    );
    expect(sellerSavedText({ ...FULL, invoiceIban: "" })).toBe(
      "Tallennettu. Laskun lähettämiseen tarvitaan vielä tilinumero."
    );
  });
});
