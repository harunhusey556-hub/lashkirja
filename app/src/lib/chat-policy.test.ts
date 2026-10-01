import { describe, expect, it } from "vitest";
import {
  asksAboutProfile,
  asksVatThisMonth,
  greetingReply,
  isGreeting,
  isMatchRequest,
  limitedModeNotice,
  matchStatusReply,
  prefersEnglish,
  providerFailedNotice,
} from "./chat-policy";

describe("chat policy", () => {
  it("treats a hello as a greeting instead of a profile dump", () => {
    expect(isGreeting("Hello")).toBe(true);
    expect(isGreeting("Hei!")).toBe(true);
    expect(greetingReply(true)).not.toMatch(/profiil/i);
    expect(greetingReply(false)).not.toMatch(/asetusten pohjalta/);
  });

  it("does not treat a bare invoice question as a match action", () => {
    expect(isMatchRequest("Mikä on laskun ALV?")).toBe(false);
    expect(isMatchRequest("Kohdista kuitit")).toBe(true);
    expect(isMatchRequest("Täsmäytä kuitit")).toBe(true);
  });

  it("F58: only a clear question about this month's VAT is a VAT question", () => {
    for (const text of ["Mikä on tämän kuun ALV?", "Paljonko ALV:ia maksan tässä kuussa?", "How much VAT do I owe this month?", "ALV?"]) {
      expect(asksVatThisMonth(text), text).toBe(true);
    }
    // "palvelun" holds "alv", "ovat" holds "vat", "veroilmoitus" holds "vero": none is a VAT question.
    for (const text of [
      "Miten hinnoittelen palvelun?",
      "Missä ovat kuittini?",
      "Mikä on kalvon hinta?",
      "Tarvitsen apua veroilmoituksen kanssa",
      "Mikä on kotitalousvähennys?",
      "Mitä voin tehdä tällä sovelluksella?",
      "Kirjoita runo kulutuksesta",
      "Mitä ALV on?",
    ]) {
      expect(asksVatThisMonth(text), text).toBe(false);
    }
  });

  it("F58: the profile is shown only when asked for", () => {
    expect(asksAboutProfile("Mikä on yritysmuotoni?")).toBe(true);
    expect(asksAboutProfile("Näytä profiili")).toBe(true);
    expect(asksAboutProfile("Miten muokkaan profiilia?")).toBe(false);
    expect(asksAboutProfile("Kerro runo yritysmuodoista")).toBe(false);
  });

  it("does not call an empty bank all matched", () => {
    const reply = matchStatusReply({
      totalTransactions: 0,
      unmatched: 0,
      openReceipts: 0,
      english: false,
    });
    expect(reply).toMatch(/ei ole vielä/);
    expect(reply).not.toMatch(/jo täsmäytetty/);
  });

  it("says calmly what works when no model answers, never a limited-mode label or internals", () => {
    for (const english of [false, true]) {
      for (const text of [limitedModeNotice(english), providerFailedNotice(english)]) {
        expect(text).not.toMatch(/Rajattu|Rajoitettu|Limited mode|kielimalli|provider|Copilot|token/i);
      }
    }
    expect(limitedModeNotice(false)).toMatch(/kohdistaa kuitit/);
    expect(limitedModeNotice(false).match(/[.!?]/g)).toHaveLength(1);
    expect(limitedModeNotice(false)).toMatch(/ALV/);
    expect(providerFailedNotice(false)).toMatch(/Yritä/);
    expect(prefersEnglish("Hello there")).toBe(true);
    expect(prefersEnglish("Mikä on ALV")).toBe(false);
  });
});
