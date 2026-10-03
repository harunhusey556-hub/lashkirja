import { describe, expect, it } from "vitest";
import { enrichExtractedReceipt, normalizeAIResult } from "./ai";

describe("the AI's amounts are whole cents", () => {
  it("rounds the total and every VAT line, as /api/receipts/save requires", () => {
    const result = normalizeAIResult(
      { vendor: "K-Market", totalAmount: 12.3456, vatDetails: [{ rate: 14, amount: 1.51666 }, { rate: 25.5, amount: 0.004 }] },
      "openai-compatible"
    );
    expect(result.totalAmount).toBe(12.35);
    expect(result.vatDetails).toEqual([{ rate: 14, amount: 1.52 }, { rate: 25.5, amount: 0 }]);
  });
});

describe("normalizeAIResult documentType", () => {
  it("keeps the kind of document the AI recognised", () => {
    expect(normalizeAIResult({ documentType: "markkinointi" }, "openai-compatible").documentType).toBe("marketing");
    expect(normalizeAIResult({ documentType: "kuitti" }, "openai-compatible").documentType).toBe("receipt");
    expect(normalizeAIResult({ documentType: "lasku" }, "openai-compatible").documentType).toBe("invoice");
    expect(normalizeAIResult({ documentType: "muu" }, "openai-compatible").documentType).toBe("other");
  });

  it("is null when the AI said nothing usable", () => {
    expect(normalizeAIResult({}, "openai-compatible").documentType).toBeNull();
    expect(normalizeAIResult({ documentType: "??" }, "openai-compatible").documentType).toBeNull();
  });
});

describe("A4: the cloud reading's confidence follows what was read", () => {
  const full = {
    vendor: "K-Market",
    date: "2026-09-12",
    totalAmount: 12.4,
    vatDetails: [{ rate: 14, amount: 1.52 }],
    documentType: "kuitti",
  };

  it("is high only when vendor, date, total and consistent VAT lines were read", () => {
    const high = normalizeAIResult(full, "openai-compatible").confidence;
    expect(high).toBeGreaterThanOrEqual(0.9);
    expect(high).toBeLessThanOrEqual(0.95);
    expect(normalizeAIResult({ ...full, date: null }, "openai-compatible").confidence).toBeLessThan(high);
    expect(normalizeAIResult({ ...full, vendor: "" }, "openai-compatible").confidence).toBeLessThan(high);
    expect(normalizeAIResult({ ...full, totalAmount: null }, "openai-compatible").confidence).toBeLessThan(0.8);
    expect(normalizeAIResult({ ...full, vatDetails: [] }, "openai-compatible").confidence).toBeLessThan(high);
    expect(normalizeAIResult({}, "openai-compatible").confidence).toBeLessThan(0.55);
  });

  it("drops when the VAT lines add up to more than the total", () => {
    const inconsistent = normalizeAIResult({ ...full, vatDetails: [{ rate: 25.5, amount: 20 }] }, "openai-compatible");
    expect(inconsistent.confidence).toBeLessThan(0.75);
  });

  it("is lower for a document that is not a bill", () => {
    expect(normalizeAIResult({ ...full, documentType: "markkinointi" }, "openai-compatible").confidence).toBeLessThan(0.8);
  });

  it("is never the old constant for an empty reading", () => {
    expect(normalizeAIResult({ vendor: "X" }, "github-copilot").confidence).not.toBe(0.85);
  });
});

describe("A4: VAT guessed from the category is marked as guessed", () => {
  it("marks a guessed VAT line and says so in the notes", () => {
    const read = normalizeAIResult({ vendor: "Kampaamotukku", date: "2026-09-12", totalAmount: 125.5, vatDetails: [], category: "tarvikkeet", documentType: "kuitti" }, "openai-compatible");
    const enriched = enrichExtractedReceipt({ ...read, rawText: "" });
    expect(enriched.vatDetails.length).toBeGreaterThan(0);
    expect(enriched.vatGuessed).toBe(true);
    expect(enriched.notes).toMatch(/arvioitu/);
    expect(enriched.confidence).toBeLessThanOrEqual(read.confidence);
  });

  it("leaves VAT that was read on the receipt unmarked", () => {
    const read = normalizeAIResult({ vendor: "K-Market", date: "2026-09-12", totalAmount: 12.4, vatDetails: [{ rate: 14, amount: 1.52 }] }, "openai-compatible");
    const enriched = enrichExtractedReceipt({ ...read, rawText: "" });
    expect(enriched.vatGuessed).toBeFalsy();
    expect(enriched.vatDetails).toEqual([{ rate: 14, amount: 1.52 }]);
  });

  it("marks an exempt guess too, with a note that it was not read", () => {
    const read = normalizeAIResult({ vendor: "Vakuutus Oy", date: "2026-09-12", totalAmount: 50, vatDetails: [], category: "vakuutus" }, "openai-compatible");
    const enriched = enrichExtractedReceipt({ ...read, rawText: "" });
    expect(enriched.vatDetails).toEqual([{ rate: 0, amount: 0 }]);
    expect(enriched.vatGuessed).toBe(true);
    expect(enriched.notes).toMatch(/arvioitu/);
  });
});
