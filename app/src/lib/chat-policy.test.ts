import { describe, expect, it } from "vitest";
import {
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
    expect(isMatchRequest("Täsmäytä kuitit")).toBe(true);
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
    expect(limitedModeNotice(false)).toMatch(/täsmäyttää kuitit/);
    expect(limitedModeNotice(false)).toMatch(/ALV/);
    expect(providerFailedNotice(false)).toMatch(/Yritä/);
    expect(prefersEnglish("Hello there")).toBe(true);
    expect(prefersEnglish("Mikä on ALV")).toBe(false);
  });
});
