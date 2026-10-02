import { describe, expect, it } from "vitest";
import { bankMatches } from "./bank-search";

describe("bank picker search", () => {
  it("matches word starts, not any letter inside a name", () => {
    expect(bankMatches("Danske Bank", "a")).toBe(false);
    expect(bankMatches("Aktia", "a")).toBe(true);
    expect(bankMatches("Danske Bank", "bank")).toBe(true);
    expect(bankMatches("Danske Bank", "dan ba")).toBe(true);
  });

  it("matches Finnish letters by their plain forms", () => {
    expect(bankMatches("Säästöpankki", "saasto")).toBe(true);
    expect(bankMatches("Säästöpankki", "Sääst")).toBe(true);
    expect(bankMatches("Ålandsbanken", "aland")).toBe(true);
  });

  it("matches a name typed without its spaces", () => {
    expect(bankMatches("S-Pankki", "spankki")).toBe(true);
    expect(bankMatches("OP Financial Group", "op")).toBe(true);
  });

  it("shows everything for an empty query", () => {
    expect(bankMatches("Nordea", "  ")).toBe(true);
  });
});
