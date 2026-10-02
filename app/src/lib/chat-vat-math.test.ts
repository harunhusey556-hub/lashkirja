import { describe, expect, it } from "vitest";
import { enforceAssistantReply, EMPTY_HONESTY } from "./chat-honesty";
import { userEuroAmounts, userQuantities, userVatFigures, userVatRates, vatArithmeticReply, vatFigureAmounts } from "./chat-vat-math";

const guard = (message: string, reply: string) =>
  enforceAssistantReply(reply, { ...EMPTY_HONESTY, allowedAmounts: vatFigureAmounts(userVatFigures(message)) }).rejected;

describe("chat VAT math", () => {
  it("reads amounts and rates the way people type them", () => {
    expect(userEuroAmounts("Ostin liimaa 49,80 € ja 1 200 euroa, €12.5")).toEqual([49.8, 1200, 12.5]);
    expect(userEuroAmounts("Mikä on ALV 24 %:lla 200 eurosta?")).toEqual([200]);
    expect(userEuroAmounts("hinta 59,90e")).toEqual([59.9]);
    expect(userVatRates("sis. alv 25,5 %")).toEqual([25.5]);
    expect(userVatRates("alv 0 %")).toEqual([0]);
    expect(userVatRates("paljonko alv on?")).toEqual([25.5, 14, 13.5, 10]);
    expect(userVatRates("hinta 45 €")).toEqual([]);
  });

  it("reads quantities", () => {
    expect(userQuantities("myyn 3 kertaa 89 €")).toEqual([{ count: 3, unit: 89 }]);
    expect(userQuantities("5 x 12,50 €")).toEqual([{ count: 5, unit: 12.5 }]);
    expect(userQuantities("kolme kertaa 20 euroa")).toEqual([{ count: 3, unit: 20 }]);
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
    expect(guard("45 € sis. alv 25,5 %", "Veroton hinta on 35,86 € ja ALV 9,14 €.")).toBe(false);
    expect(guard("45 € sis. alv 25,5 %", "Veroton hinta on 36,00 €.")).toBe(true);
  });

  it("accepts totals of several amounts, row by row or as one sum", () => {
    const message = "Ostin kaksi tuotetta: 45 € ja 49,80 €, molemmat sis. alv 25,5 %. Paljonko alv yhteensä?";
    // 9,14 + 10,12 = 19,26 row by row; the VAT of 94,80 € is 19,26 € too.
    expect(guard(message, "ALV yhteensä 19,26 €, veroton yhteensä 75,54 €.")).toBe(false);
  });

  it("accepts a quantity times a price, with a cent of rounding either way", () => {
    const message = "Paljonko alvia maksan jos myyn 3 kertaa 89 € (sis alv 25,5%)?";
    expect(guard(message, "Myynti 267,00 €, josta ALV 54,25 €.")).toBe(false);
    expect(guard(message, "3 × 18,08 € = 54,24 €.")).toBe(false);
    expect(guard(message, "ALV on 60,00 €.")).toBe(true);
  });

  it("handles an amount in another case ending", () => {
    expect(guard("Mikä on ALV 24 %:lla 200 eurosta?", "ALV on 48,00 €, yhteensä 248,00 €.")).toBe(false);
  });

  it("answers from the figures alone when no model is available", () => {
    const reply = vatArithmeticReply(userVatFigures("45 € sis. alv 25,5 %"), false);
    expect(reply).toContain("veroton 35,86 €, ALV 9,14 €");
    expect(guard("45 € sis. alv 25,5 %", reply)).toBe(false);
  });
});
