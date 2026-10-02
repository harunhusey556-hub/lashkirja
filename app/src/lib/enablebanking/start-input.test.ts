import { describe, expect, it } from "vitest";
import { startSchema } from "./start-input";

const base = { aspspName: "Nordea", psuType: "business" as const };

describe("bank connect input", () => {
  it("accepts a real past day as the first sync start", () => {
    expect(startSchema.parse({ ...base, historyFrom: "2026-01-01" }).historyFrom).toBe("2026-01-01");
  });

  it("refuses a day that does not exist", () => {
    expect(startSchema.safeParse({ ...base, historyFrom: "2026-02-31" }).success).toBe(false);
  });

  it("refuses a future day", () => {
    expect(startSchema.safeParse({ ...base, historyFrom: "2999-01-01" }).success).toBe(false);
  });

  it("defaults the country and the client", () => {
    const parsed = startSchema.parse(base);
    expect(parsed.aspspCountry).toBe("FI");
    expect(parsed.client).toBe("web");
  });
});
