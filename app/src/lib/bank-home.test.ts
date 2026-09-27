import { describe, expect, it } from "vitest";
import { bankHomeLead } from "./bank-home";

describe("bank home", () => {
  it("shows connected accounts instead of asking for a first manual bank", () => {
    expect(bankHomeLead(1)).toBe("accounts");
    expect(bankHomeLead(0)).toBe("connect");
  });
});
