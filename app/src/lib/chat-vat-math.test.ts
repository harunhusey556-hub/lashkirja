import { describe, expect, it } from "vitest";
import { enforceAssistantReply, EMPTY_HONESTY } from "./chat-honesty";
import { userEuroAmounts, userVatFigures, userVatRates, vatFigureAmounts } from "./chat-vat-math";

describe("chat VAT math", () => {
  it("reads amounts and rates the way people type them", () => {
    expect(userEuroAmounts("Ostin liimaa 49,80 € ja 1 200 euroa, €12.5")).toEqual([49.8, 1200, 12.5]);
    expect(userVatRates("sis. alv 25,5 %")).toEqual([25.5]);
    expect(userVatRates("paljonko alv on?")).toEqual([25.5, 14, 13.5, 10]);
    expect(userVatRates("hinta 45 €")).toEqual([]);
  });

  it("splits an amount both ways", () => {
    const [f] = userVatFigures("Huoltokäynti maksaa 45 € sis. alv 25,5 %.");
    expect(f).toEqual({
      amount: "45.00",
      rate: 25.5,
      included: { net: "35.86", vat: "9.14" },
      excluded: { vat: "11.48", gross: "56.48" },
    });
  });

  it("lets the guard accept the server's figures and nothing else", () => {
    const allowed = vatFigureAmounts(userVatFigures("45 € sis. alv 25,5 %"));
    const honesty = { ...EMPTY_HONESTY, allowedAmounts: allowed };
    expect(enforceAssistantReply("Veroton hinta on 35,86 € ja ALV 9,14 €.", honesty).rejected).toBe(false);
    expect(enforceAssistantReply("Veroton hinta on 36,00 €.", honesty).rejected).toBe(true);
  });
});
