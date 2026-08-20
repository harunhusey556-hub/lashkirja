import { describe, it, expect } from "vitest";
import {
  parseBusinessDetails,
  generateProfileSummary,
  BusinessProfile,
} from "./onboarding";

describe("onboarding lib", () => {
  it("parses empty or invalid json string safely with defaults", () => {
    const profile = parseBusinessDetails(null);
    expect(profile.entityType).toBe("toiminimi");
    expect(profile.vatRegistered).toBe(false);
    expect(profile.vatPeriod).toBe("month");
  });

  it("parses valid JSON business details string", () => {
    const json = JSON.stringify({
      entityType: "oy",
      vatRegistered: true,
      vatPeriod: "quarter",
      salesTypes: ["ripsipalvelut", "tuotemyynti"],
      expenseCategories: ["tarvikkeet", "vuokra"],
    });

    const profile = parseBusinessDetails(json);
    expect(profile.entityType).toBe("oy");
    expect(profile.vatRegistered).toBe(true);
    expect(profile.vatPeriod).toBe("quarter");
    expect(profile.salesTypes).toEqual(["ripsipalvelut", "tuotemyynti"]);
  });

  it("generates a clear Finnish profile summary", () => {
    const profile: BusinessProfile = {
      entityType: "toiminimi",
      vatRegistered: true,
      vatPeriod: "month",
      salesTypes: ["ripsipalvelut"],
      expenseCategories: ["tarvikkeet"],
    };

    const summary = generateProfileSummary(profile);
    expect(summary).toContain("Yritysmuoto: Toiminimi");
    expect(summary).toContain("ALV: ALV-rekisterissä (kausi: kuukausi)");
  });
});
