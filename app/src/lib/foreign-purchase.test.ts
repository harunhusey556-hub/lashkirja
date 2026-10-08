import { describe, expect, it } from "vitest";
import { foreignFieldsFromExtraction, suggestPurchaseVatTreatment } from "./foreign-purchase";

const base = { vatDetails: [] as Array<{ rate: number; amount: number }> };

describe("suggestPurchaseVatTreatment", () => {
  it("keeps Finnish and unknown-country euro documents domestic", () => {
    expect(suggestPurchaseVatTreatment({ ...base, sellerCountry: "FI", currency: "EUR" })).toBe("domestic");
    expect(suggestPurchaseVatTreatment({ ...base })).toBe("domestic");
    expect(suggestPurchaseVatTreatment({ ...base, sellerCountry: "US", type: "tulo" })).toBe("domestic");
  });

  it("tells EU services from EU goods", () => {
    expect(suggestPurchaseVatTreatment({ ...base, sellerCountry: "IE", category: "ohjelmistot" })).toBe("eu_service");
    expect(suggestPurchaseVatTreatment({ ...base, sellerCountry: "DE", category: "tarvikkeet" })).toBe("eu_goods");
  });

  it("takes a foreign currency without a country as a non-EU service", () => {
    expect(suggestPurchaseVatTreatment({ ...base, currency: "USD", category: "ohjelmistot" })).toBe("non_eu_service");
    expect(suggestPurchaseVatTreatment({ ...base, sellerCountry: "CN", category: "tarvikkeet" })).toBe("non_eu_goods");
  });

  it("recognises Finnish VAT a foreign seller charged", () => {
    expect(
      suggestPurchaseVatTreatment({ ...base, sellerCountry: "IE", vatDetails: [{ rate: 25.5, amount: 4590 }] })
    ).toBe("foreign_vat_charged");
  });
});

describe("foreignFieldsFromExtraction", () => {
  it("defaults the currency to EUR", () => {
    expect(foreignFieldsFromExtraction({ ...base, currency: null })).toEqual({ currency: "EUR", vatTreatment: "domestic" });
    expect(foreignFieldsFromExtraction({ ...base, currency: "USD" }).currency).toBe("USD");
  });
});
