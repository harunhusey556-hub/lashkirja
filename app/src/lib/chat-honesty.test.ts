import { describe, expect, it } from "vitest";
import { centsToEuros } from "./money";
import { greetingReply, limitedModeNotice, matchStatusReply } from "./chat-policy";
import {
  explainsLimitedMode,
  formatBookedVatAnswer,
  replyClaimsUnperformedAction,
  replyUsesCalculatedAmount,
  EMPTY_HONESTY,
  enforceAssistantReply,
  guardStreamReply,
  sourcesFromText,
} from "./chat-honesty";
import { settleChatStream } from "./chat-turn";

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
      { label: "ALV-raportti", href: "/kirjanpito/alv?period=2026-09" },
    ]);
    expect(replyClaimsUnperformedAction(answer.text)).toBe(false);
  });

  it("rejects a fabricated action, amount, record, or period link", () => {
    const ctx = {
      performedActions: [],
      allowedAmounts: ["12.50"],
      allowedRecordIds: ["aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"],
      allowedHrefs: ["/kirjanpito/alv?period=2026-09"],
    };
    expect(enforceAssistantReply("ALV 12.50 €. Lähde: /kirjanpito/alv?period=2026-09.", ctx).rejected).toBe(false);
    expect(enforceAssistantReply("Yhdistin kuitin.", ctx).reason).toBe("unperformed");
    expect(enforceAssistantReply("ALV 99.00 €.", ctx).reason).toBe("amount");
    expect(
      enforceAssistantReply("Kuitti bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.", ctx).reason
    ).toBe("record");
    expect(enforceAssistantReply("Katso /kuitit?month=1999-01.", ctx).reason).toBe("source");
    expect(enforceAssistantReply("Katso /kuitit.", ctx).rejected).toBe(false);
    expect(enforceAssistantReply("Yhdistin kuitin.", { ...ctx, performedActions: ["match"] }).rejected).toBe(
      false
    );
  });

  it("does not keep a half stream or a timeout that invents a book change", () => {
    const timedOut = guardStreamReply(
      settleChatStream({ reason: "timeout", collected: "Yhdistin kuitin 99,00 €." }),
      EMPTY_HONESTY
    );
    expect(timedOut.rejected).toBe(true);
    expect(timedOut.status).toBe("incomplete");
    expect(timedOut.content).not.toMatch(/Yhdistin/);
    const finished = guardStreamReply(
      settleChatStream({ reason: "complete", collected: "I updated your books." }),
      EMPTY_HONESTY
    );
    expect(finished.status).toBe("incomplete");
    expect(finished.content).not.toMatch(/updated your books/i);
    const emptyTimeout = guardStreamReply(
      settleChatStream({ reason: "timeout", collected: "" }),
      EMPTY_HONESTY
    );
    expect(emptyTimeout.status).toBe("failed");
    expect(emptyTimeout.rejected).toBe(false);
  });

  it("collects book links cited in a reply", () => {
    expect(
      sourcesFromText("Katso [ALV](/kirjanpito/alv?period=2026-09) ja /kuitit?month=2026-09.")
    ).toEqual([
      { label: "ALV-raportti", href: "/kirjanpito/alv?period=2026-09" },
      { label: "Kuitit", href: "/kuitit?month=2026-09" },
    ]);
  });

  it("recognizes the new ALV path as a bare link", () => {
    expect(
      sourcesFromText("Katso /kirjanpito/alv?period=2026-09 ja /kuitit?month=2026-09.")
    ).toEqual([
      { label: "ALV-raportti", href: "/kirjanpito/alv?period=2026-09" },
      { label: "Kuitit", href: "/kuitit?month=2026-09" },
    ]);
  });

  it("still checks the legacy /alv-raportti link against allowedHrefs", () => {
    const ctx = {
      performedActions: [],
      allowedAmounts: [],
      allowedRecordIds: [],
      allowedHrefs: [],
    };
    const result = enforceAssistantReply("[ALV](/alv-raportti?period=1999-01)", ctx);
    expect(result.rejected).toBe(true);
    expect(result.reason).toBe("source");
  });
});
