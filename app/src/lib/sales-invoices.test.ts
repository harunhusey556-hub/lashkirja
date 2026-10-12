import { describe, expect, it } from "vitest";
import { creditableRemainder } from "./sales-invoices";

const original = {
  grossCents: 12550,
  lines: [
    { id: "a", sortOrder: 0, quantityMilli: 1000 },
    { id: "b", sortOrder: 1, quantityMilli: 2000 },
  ],
};

describe("creditableRemainder", () => {
  it("is the whole invoice before any credit note", () => {
    const remainder = creditableRemainder(original, []);
    expect(remainder.grossCents).toBe(12550);
    expect(remainder.byLineId.get("a")).toBe(1000);
    expect(remainder.byLineId.get("b")).toBe(2000);
  });

  it("takes off what a credit note already reversed, line by line", () => {
    const remainder = creditableRemainder(original, [
      // The note's amounts are negative; its quantities stay positive.
      { grossCents: -5020, lines: [{ sortOrder: 0, quantityMilli: 400 }] },
    ]);
    expect(remainder.grossCents).toBe(7530);
    expect(remainder.byLineId.get("a")).toBe(600);
    expect(remainder.byLineId.get("b")).toBe(2000);
  });

  it("adds up several credit notes and never goes below zero", () => {
    const remainder = creditableRemainder(original, [
      { grossCents: -5020, lines: [{ sortOrder: 0, quantityMilli: 400 }] },
      { grossCents: -2510, lines: [{ sortOrder: 0, quantityMilli: 200 }] },
      // Written outside this path: more than the line ever had.
      { grossCents: -1000, lines: [{ sortOrder: 1, quantityMilli: 9000 }] },
    ]);
    expect(remainder.grossCents).toBe(4020);
    expect(remainder.byLineId.get("a")).toBe(400);
    expect(remainder.byLineId.get("b")).toBe(0);
  });
});
