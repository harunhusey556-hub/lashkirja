import { describe, expect, it } from "vitest";
import { customerSearchFields, matchesSearch, normalizeSearch } from "./search";

describe("search helpers", () => {
  it("folds Finnish and Turkish letters regardless of case", () => {
    for (const q of ["äiti", "Äiti", "ÄITI"]) expect(matchesSearch(q, ["Äiti Oy"])).toBe(true);
    expect(matchesSearch("öljy", ["Öljy Ab"])).toBe(true);
    expect(matchesSearch("ünlü", ["Ünlü"])).toBe(true);
    expect(matchesSearch("şükrü", ["ŞÜKRÜ"])).toBe(true);
    expect(matchesSearch("łukasz", ["ŁUKASZ"])).toBe(true);
    expect(matchesSearch("istanbul", ["İstanbul Oy"])).toBe(true);
    expect(normalizeSearch("ISPARTA")).toBe("isparta");
  });

  it("treats % and _ literally", () => {
    expect(matchesSearch("%", ["Anna"])).toBe(false);
    expect(matchesSearch("_", ["Anna"])).toBe(false);
    expect(matchesSearch("50%", ["Alennus 50% Oy"])).toBe(true);
    expect(matchesSearch("a_b", ["a_b Oy"])).toBe(true);
    expect(matchesSearch("a_b", ["axb Oy"])).toBe(false);
  });

  it("finds a customer by Y-tunnus with or without the dash and by e-mail", () => {
    const fields = customerSearchFields({
      name: "Liisa",
      email: "Liisa@Example.invalid",
      businessId: "0201256-6",
    });
    expect(matchesSearch("0201256-6", fields)).toBe(true);
    expect(matchesSearch("02012566", fields)).toBe(true);
    expect(matchesSearch("example.invalid", fields)).toBe(true);
    expect(matchesSearch("muu", fields)).toBe(false);
  });

  it("an empty query matches everything", () => {
    expect(matchesSearch("  ", ["x"])).toBe(true);
  });
});
