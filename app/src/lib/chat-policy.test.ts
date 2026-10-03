import { describe, expect, it } from "vitest";
import {
  asksAboutProfile,
  asksBookedVat,
  asksVatThisMonth,
  greetingReply,
  isGreeting,
  isMatchRequest,
  limitedModeNotice,
  matchStatusReply,
  parseVatPeriod,
  prefersEnglish,
  providerFailedNotice,
  replyLanguage,
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

describe("A1: the VAT period a question asks about", () => {
  // 3 October 2026, Helsinki.
  const now = new Date("2026-10-03T09:00:00.000Z");

  it.each([
    ["Mikä oli viime kuun ALV?", "2026-09"],
    ["Paljonko edellisen kuun ALV oli?", "2026-09"],
    ["How much VAT did I owe last month?", "2026-09"],
    ["Geçen ay KDV ne kadar?", "2026-09"],
    ["Hur mycket moms för förra månaden?", "2026-09"],
    ["Syyskuun ALV?", "2026-09"],
    ["What was the VAT for September?", "2026-09"],
    ["Eylül KDV ne kadar?", "2026-09"],
    ["Joulukuun ALV", "2025-12"],
    ["Syyskuun 2025 ALV", "2025-09"],
    ["Q3 ALV paljonko?", "2026-Q3"],
    ["Kolmannen neljänneksen ALV", "2026-Q3"],
    ["Paljonko on kolmas neljännes ALV:na?", "2026-Q3"],
    ["VAT for the third quarter", "2026-Q3"],
    ["Mikä on tämän kuun ALV?", "2026-10"],
    ["Paljonko ALV on tämä kuu?", "2026-10"],
    ["Bu ay KDV ne kadar?", "2026-10"],
    ["Edellisen neljänneksen ALV", "2026-Q3"],
    ["Viime vuoden ALV", "2025"],
  ])("%s → %s", (text, key) => {
    expect(parseVatPeriod(text, now, "month").key).toBe(key);
  });

  it("follows the owner's VAT period when the question names none", () => {
    expect(parseVatPeriod("Paljonko ALV maksan?", now, "month")).toMatchObject({ key: "2026-10", explicit: false });
    expect(parseVatPeriod("Paljonko ALV maksan?", now, "quarter")).toMatchObject({ key: "2026-Q4", explicit: false });
    expect(parseVatPeriod("Paljonko ALV maksan?", now, "year")).toMatchObject({ key: "2026", explicit: false });
    expect(parseVatPeriod("Viime kauden ALV?", now, "quarter").key).toBe("2026-Q3");
    expect(parseVatPeriod("Viime kauden ALV?", now, "month").key).toBe("2026-09");
    // A named month is that month, whatever the owner files.
    expect(parseVatPeriod("Viime kuun ALV?", now, "quarter")).toMatchObject({ key: "2026-09", explicit: true });
  });

  it("rolls back over the turn of the year", () => {
    const january = new Date("2026-01-15T09:00:00.000Z");
    expect(parseVatPeriod("viime kuun ALV", january, "month").key).toBe("2025-12");
    expect(parseVatPeriod("last quarter VAT", january, "month").key).toBe("2025-Q4");
    expect(parseVatPeriod("Q3 VAT", january, "month").key).toBe("2025-Q3");
  });

  it("enters the exact-figure path in every language it reads", () => {
    for (const text of [
      "Bu ay KDV ne kadar?",
      "Geçen ay KDV ne kadar?",
      "Syyskuun ALV?",
      "Viime kuun ALV",
      "VAT for September",
      "Hur mycket moms ska jag betala?",
      "Momsen förra månaden?",
      "Q3 ALV",
    ]) {
      expect(asksBookedVat(text), text).toBe(true);
      expect(asksVatThisMonth(text), text).toBe(true);
    }
    for (const text of ["Mikä on ALV-kanta?", "What is the VAT rate in September?", "KDV oranı nedir?", "Mitä ALV on?"]) {
      expect(asksBookedVat(text), text).toBe(false);
    }
  });
});

describe("A6: match and greeting intents in every language", () => {
  it("reads a Turkish or Swedish match request", () => {
    for (const text of ["Fişi banka işlemiyle eşleştir", "eşleştir", "Fişleri eşleştirir misin?", "Matcha kvittona", "Kohdista kuitit", "match my receipts"]) {
      expect(isMatchRequest(text), text).toBe(true);
    }
    expect(isMatchRequest("KDV ne kadar?")).toBe(false);
  });

  it("greets back in Turkish", () => {
    expect(isGreeting("Merhaba")).toBe(true);
    expect(isGreeting("Selam!")).toBe(true);
    expect(isGreeting("Hej")).toBe(true);
    expect(greetingReply("tr")).toMatch(/Merhaba/);
    expect(greetingReply(true)).toMatch(/^Hello/);
    expect(greetingReply(false)).toMatch(/^Hei/);
  });
});

describe("A1: an English VAT question is answered in English", () => {
  it.each(["How much VAT did I owe last month?", "VAT for September", "What is my VAT this quarter?"])("%s", (text) => {
    expect(replyLanguage(text)).toBe("en");
  });
  it.each(["Mikä oli viime kuun ALV?", "Bu ay KDV ne kadar?", "Syyskuun ALV?"])("%s is not English", (text) => {
    expect(replyLanguage(text)).not.toBe("en");
  });
});
