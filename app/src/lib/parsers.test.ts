import { describe, it, expect } from "vitest";
import { parseHolviTilioteLayout, parseAmountValue } from "./parsers";
import { inferTransactionType } from "./statements";

const HOLVI_SNIPPET = `
Kirjauspäivä                                  Maksutiedot                                           Tapahtuman nro                    Määrä EUR
 10.7.2026                                     Arvopäivä: 9.7.2026                                                     6               - 197,72
                                               Arkistointitunnus:
                                               3322d6bec19115b8f0b8703ac752b940
                                               FI80 8146 9710 1714 47
                                               YTH-yritystietohaku
                                               Viite: 299510
                                               Varattu: 10. heinäkuuta 2026
                                               kello 1.33
                                               Lähtevä maksu
 8.7.2026                                      Arvopäivä: 8.7.2026                                                     2                + 65,00
                                               VIPPS MOBILEPAY AS,
                                               Viesti: MobilePay Alina
                                               SEPA-maksu
`;

describe("parseAmountValue", () => {
  it("parses spaced minus before amount", () => {
    expect(parseAmountValue("- 197,72")).toBe(-197.72);
  });
});

describe("parseHolviTilioteLayout", () => {
  it("extracts outgoing Holvi payments as negative meno with real counterparty", () => {
    const txs = parseHolviTilioteLayout(HOLVI_SNIPPET);
    const yth = txs.find((tx) => tx.counterparty?.includes("YTH"));
    expect(yth).toMatchObject({
      date: "2026-07-10",
      counterparty: "YTH-yritystietohaku",
      amount: -197.72,
      reference: "299510",
    });
    expect(inferTransactionType(yth!.amount, yth!)).toBe("meno");
  });

  it("keeps incoming MobilePay credits positive", () => {
    const txs = parseHolviTilioteLayout(HOLVI_SNIPPET);
    const mobilePay = txs.find((tx) => tx.counterparty?.includes("VIPPS"));
    expect(mobilePay?.amount).toBe(65);
    expect(inferTransactionType(mobilePay!.amount, mobilePay!)).toBe("tulo");
  });
});
