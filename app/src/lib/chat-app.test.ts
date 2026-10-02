import { describe, expect, it } from "vitest";
import { asksToConnectBank, suggestedChatActions } from "./chat-app";
describe("assistant navigation", () => {
  it.each(["Bankamı nereden bağlayabilirim?", "Mistä yhdistän pankkini?", "How do I connect my bank?"])("offers verified bank setup for %s", question => {
    expect(asksToConnectBank(question)).toBe(true);
    expect(suggestedChatActions(question)).toContainEqual({ label: "Yhdistä pankki", href: "/kirjanpito/pankkitilit?connect=1", kind: "action" });
  });
  it("does not turn a balance question into a connect action answer", () => {
    expect(asksToConnectBank("What is my bank balance?")).toBe(false);
  });
  it("selects seller setup rather than creating an invoice for IBAN questions", () => {
    expect(suggestedChatActions("Mihin lisään laskuttajan IBANin?")[0].href).toBe("/asetukset/laskutus");
  });
});
