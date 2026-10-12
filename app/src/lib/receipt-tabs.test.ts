import { describe, expect, it } from "vitest";
import { receiptTabChips, receiptTabFromQuery, receiptTabQuery, ZERO_RECEIPT_TAB_COUNTS } from "./receipt-tabs";

describe("receipt-tabs", () => {
  it("builds six chips in a fixed order with their counts, Laskut last", () => {
    const chips = receiptTabChips({ ...ZERO_RECEIPT_TAB_COUNTS, all: 9, tulo: 2, meno: 7, linked: 3, unlinked: 6, laskut: 4 });
    expect(chips.map((c) => c.id)).toEqual(["all", "tulo", "meno", "linked", "unlinked", "laskut"]);
    expect(chips.map((c) => c.label)).toEqual(["Kaikki", "Tulot", "Menot", "Kohdistettu", "Ei kohdistettu", "Laskut"]);
    expect(chips.map((c) => c.count)).toEqual([9, 2, 7, 3, 6, 4]);
  });

  it("shows no number for Laskut while its count is unknown", () => {
    expect(receiptTabChips({ all: 0, tulo: 0, meno: 0, linked: 0, unlinked: 0 }).at(-1)).toEqual({ id: "laskut", label: "Laskut", count: undefined });
  });

  it("maps each tab to its type/linkedStatus query pair and back", () => {
    for (const id of ["all", "tulo", "meno", "linked", "unlinked"] as const) {
      const query = receiptTabQuery(id);
      expect(receiptTabFromQuery(query.type, query.linkedStatus)).toBe(id);
    }
  });

  it("prefers linkedStatus over type when both happen to be set", () => {
    expect(receiptTabFromQuery("tulo", "linked")).toBe("linked");
  });
});
