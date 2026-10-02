import { describe, expect, it } from "vitest";
import { normalizeAIResult } from "./ai";

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
