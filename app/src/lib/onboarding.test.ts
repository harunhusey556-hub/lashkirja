import { describe, it, expect } from "vitest";
import {
  parseBusinessDetails,
  generateProfileSummary,
  businessProfileSchema,
  ENTITY_TYPES,
  ENTITY_TYPE_OPTIONS,
  ONBOARDING_STEPS,
  ONBOARDING_INTRO,
  BusinessProfile,
  onboardingSteps,
  profileSummaryRows,
  profileFromAnswers,
  answerText,
  sanitizeAnswers,
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

  it("rejects an unknown company type, tax period, and list value", () => {
    expect(businessProfileSchema.safeParse({
      entityType: "osuuskunta",
      vatRegistered: true,
      vatPeriod: "month",
      salesTypes: ["ripsipalvelut"],
      expenseCategories: ["tarvikkeet"],
    }).success).toBe(false);
    expect(businessProfileSchema.safeParse({
      entityType: "oy",
      vatRegistered: true,
      vatPeriod: "viikko",
      salesTypes: ["ripsipalvelut"],
      expenseCategories: ["tarvikkeet"],
    }).success).toBe(false);
    expect(businessProfileSchema.safeParse({
      entityType: "oy",
      vatRegistered: false,
      vatPeriod: "year",
      salesTypes: ["jotain-muuta"],
      expenseCategories: ["tarvikkeet"],
    }).success).toBe(false);
    expect(parseBusinessDetails(JSON.stringify({ entityType: "osuuskunta" })).entityType).toBe("toiminimi");
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

  it("uses one company-type list, including Oy, for onboarding and settings", () => {
    const step = ONBOARDING_STEPS.find((item) => item.field === "entityType");
    expect(step?.chips.map((chip) => chip.value)).toEqual([...ENTITY_TYPES]);
    expect(ENTITY_TYPE_OPTIONS.map((option) => option.value)).toEqual([...ENTITY_TYPES]);
    expect(ENTITY_TYPES).toContain("oy");
    expect(ENTITY_TYPE_OPTIONS.find((option) => option.value === "oy")?.label).toBe(
      "Osakeyhtiö (Oy)"
    );
  });

  it("uses no emoji anywhere in the questions or answers (V1)", () => {
    const emoji = /\p{Extended_Pictographic}/u;
    const texts = [ONBOARDING_INTRO];
    for (const step of ONBOARDING_STEPS) {
      texts.push(step.question, step.hint ?? "");
      for (const chip of step.chips) texts.push(chip.label, chip.detail ?? "");
    }
    for (const text of texts) expect(text).not.toMatch(emoji);
  });

  it("asks the VAT period only of a VAT-registered business", () => {
    expect(onboardingSteps({}).map((step) => step.id)).toHaveLength(5);
    expect(onboardingSteps({ vatRegistered: true }).map((step) => step.id)).toContain("vatPeriod");
    const noVat = onboardingSteps({ vatRegistered: false }).map((step) => step.id);
    expect(noVat).toHaveLength(4);
    expect(noVat).not.toContain("vatPeriod");
  });

  it("summarises with Finnish labels, never raw ids or invented defaults", () => {
    const rows = profileSummaryRows({
      entityType: "kevytyrittaja",
      vatRegistered: true,
      vatPeriod: "month",
      salesTypes: [],
      expenseCategories: ["tarvikkeet", "vuokra"],
    });
    const text = rows.map((row) => `${row.label}: ${row.value}`).join("\n");
    expect(text).toContain("Yritysmuoto: Kevytyrittäjä");
    expect(text).toContain("ALV-kausi: Kuukausittain");
    expect(text).toContain("Myynti: Ei mitään näistä");
    expect(text).toContain("Kulut: Tarvikkeet, Liiketilan vuokra");
    expect(text).not.toMatch(/month|kevytyrittaja|ripsipalvelut|Ripsipalvelut|\|/);
    expect(rows.find((row) => row.id === "vatPeriod")).toBeTruthy();
    expect(profileSummaryRows({ vatRegistered: false }).find((row) => row.id === "vatPeriod")).toBeUndefined();
  });

  it("does not invent sales or expenses in the model context either", () => {
    const summary = generateProfileSummary({
      entityType: "oy",
      vatRegistered: false,
      vatPeriod: "month",
      salesTypes: [],
      expenseCategories: [],
    });
    expect(summary).not.toMatch(/Ripsipalvelut|Tarvikkeet, vuokra/);
    expect(summary).toContain("Myynti: ei valintaa");
    expect(summary).toContain("Osakeyhtiö (Oy)");
  });

  it("builds a profile only when every asked question is answered", () => {
    expect(profileFromAnswers({ entityType: "oy", vatRegistered: true })).toBeNull();
    const profile = profileFromAnswers({
      entityType: "oy",
      vatRegistered: false,
      salesTypes: ["koulutus"],
      expenseCategories: [],
    });
    expect(profile).toEqual({
      entityType: "oy",
      vatRegistered: false,
      vatPeriod: "month",
      salesTypes: ["koulutus"],
      expenseCategories: [],
    });
    expect(businessProfileSchema.safeParse(profile).success).toBe(true);
    expect(answerText("vatRegistered", { vatRegistered: false })).toBe("En ole ALV-rekisterissä");
  });

  it("drops invalid values from a restored draft", () => {
    expect(
      sanitizeAnswers({
        entityType: "osuuskunta",
        vatRegistered: "yes",
        vatPeriod: "quarter",
        salesTypes: ["koulutus", "x", "koulutus"],
      })
    ).toEqual({ vatPeriod: "quarter", salesTypes: ["koulutus"] });
    expect(sanitizeAnswers(null)).toEqual({});
  });
});
