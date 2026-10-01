import { describe, expect, it } from "vitest";
import { overOpenMessage } from "./payment-entry";

describe("overOpenMessage", () => {
  it("is nothing for an amount that fits, to the cent", () => {
    expect(overOpenMessage(125.5, 125.5, false)).toBeNull();
    expect(overOpenMessage(100, 125.5, false)).toBeNull();
  });

  it("refuses an overpayment at once and never promises a second tap", () => {
    const message = overOpenMessage(500, 125.5, false);
    expect(message).toContain("125,50");
    expect(message).toMatch(/Kirjaa enintään avoin summa\.$/);
    expect(message).not.toMatch(/uudelleen|silti/i);
  });

  it("says the invoice is settled when nothing is open", () => {
    expect(overOpenMessage(5, 0, false)).toMatch(/jo maksettu/);
  });

  it("does not cap a payment that carries a bank row", () => {
    expect(overOpenMessage(133.9, 125.5, true)).toBeNull();
  });
});
