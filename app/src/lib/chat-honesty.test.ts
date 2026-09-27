import { describe, expect, it } from "vitest";
import { centsToEuros } from "./money";
import { greetingReply, limitedModeNotice, matchStatusReply } from "./chat-policy";
import {
  explainsLimitedMode,
  formatBookedVatAnswer,
  replyClaimsUnperformedAction,
  replyUsesCalculatedAmount,
  sourcesFromText,
} from "./chat-honesty";

describe("chat honesty", () => {
  it("does not claim a bookkeeping action in a greeting, a status, or limited mode", () => {
    const replies = [
      greetingReply(false),
      greetingReply(true),
      limitedModeNotice(false),
      matchStatusReply({
        totalTransactions: 2,
        unmatched: 2,
        openReceipts: 0,
        english: false,
      }) ?? "",
      "Tarkistin pankkitapahtumasi ja kuitit. Löysin yhden ehdotuksen. Vahvista se alta.",
    ];
    for (const reply of replies) {
      expect(replyClaimsUnperformedAction(reply)).toBe(false);
    }
    expect(replyClaimsUnperformedAction("Yhdistin kuitin tiliotteeseen.")).toBe(true);
    expect(replyClaimsUnperformedAction("I updated your books.")).toBe(true);
  });

  it("explains limited mode and cites only the calculated VAT amount", () => {
    const notice = limitedModeNotice(false);
    expect(explainsLimitedMode(notice)).toBe(true);
    const amount = centsToEuros(2550).toFixed(2);
    const answer = formatBookedVatAnswer({
      month: "2026-09",
      amount,
      isRefund: false,
      english: false,
    });
    expect(explainsLimitedMode(`${notice}\n\n${answer.text}`)).toBe(true);
    expect(replyUsesCalculatedAmount(answer.text, amount)).toBe(true);
    expect(replyUsesCalculatedAmount(answer.text, "99.00")).toBe(false);
    expect(answer.sources).toEqual([
      { label: "ALV-raportti", href: "/alv-raportti?period=2026-09" },
    ]);
    expect(replyClaimsUnperformedAction(answer.text)).toBe(false);
  });

  it("collects book links cited in a reply", () => {
    expect(
      sourcesFromText("Katso [ALV](/alv-raportti?period=2026-09) ja /kuitit?month=2026-09.")
    ).toEqual([
      { label: "ALV-raportti", href: "/alv-raportti?period=2026-09" },
      { label: "Kuitit", href: "/kuitit?month=2026-09" },
    ]);
  });
});
