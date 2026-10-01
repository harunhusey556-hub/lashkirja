import { describe, expect, it } from "vitest";
import { runPlanSummary } from "./runPlan";

const entry = (grossByDate: number[], extra = {}) => ({
  recurringInvoiceId: "r1",
  name: "Kuukausiylläpito",
  customerName: "Asiakas",
  customerEmail: null,
  autoSend: false,
  grossByDate,
  issueDates: grossByDate.map((_, i) => `2026-0${i + 1}-15`),
  ...extra,
});

const norm = (text: string) => text.replace(/ /g, " ");

describe("runPlanSummary", () => {
  it("names the amount of a single run", () => {
    expect(norm(runPlanSummary([entry([50])]))).toContain("Kuukausiylläpito 50,00 €.");
  });

  it("shows what each run will actually bill when the amounts differ (V2)", () => {
    const text = norm(runPlanSummary([entry([114, 113.5, 113.5])]));
    expect(text).toContain("1 × 114,00 € + 2 × 113,50 €");
  });
});
