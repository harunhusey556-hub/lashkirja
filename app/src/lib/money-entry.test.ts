import { describe, expect, it } from "vitest";
import { moneyEntryProblem } from "./money-entry";

describe("moneyEntryProblem", () => {
  it("accepts cents and refuses a third decimal or an absurd amount", () => {
    expect(moneyEntryProblem(124)).toBeNull();
    expect(moneyEntryProblem(124.05)).toBeNull();
    expect(moneyEntryProblem(124.005)).toBe("Summassa saa olla enintään kaksi desimaalia.");
    expect(moneyEntryProblem(99999999999)).toBe("Summa on liian suuri.");
  });
});
