import { describe, expect, it } from "vitest";
import { centsToEuros } from "./money";
import { greetingReply, limitedModeNotice, matchStatusReply } from "./chat-policy";
import {
  citedEuroAmounts,
  claimedActionKinds,
  explainsLimitedMode,
  formatBookedVatAnswer,
  mergeSources,
  replyClaimsUnperformedAction,
  replyUsesCalculatedAmount,
  EMPTY_HONESTY,
  enforceAssistantReply,
  guardStreamReply,
  sourcesFromText,
  vatReturnNote,
} from "./chat-honesty";
import { humanizeScreenPaths } from "./chat-honesty";
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
      { label: "ALV-ilmoitus", href: "/kirjanpito/alv?period=2026-09" },
    ]);
    expect(replyClaimsUnperformedAction(answer.text)).toBe(false);
  });

  it("F59: the VAT answer is written for a person, with one link chip", () => {
    const answer = formatBookedVatAnswer({ month: "2026-09", amount: "287.01", isRefund: false, english: false });
    expect(answer.text).toBe("Syyskuun ALV: maksettavaa 287,01 €.");
    expect(answer.amount).toBe("287.01");
    // No route path, no ISO period, no dot decimal, no field number.
    expect(answer.text).not.toMatch(/\/kirjanpito|2026-09|\d\.\d{2}|kohta 308|Lähde/);
    expect(answer.sources).toEqual([{ label: "ALV-ilmoitus", href: "/kirjanpito/alv?period=2026-09" }]);
    const refund = formatBookedVatAnswer({ month: "2026-01", amount: "12.50", isRefund: true, english: false });
    expect(refund.text).toBe("Tammikuun ALV: palautusta 12,50 €.");
    expect(replyUsesCalculatedAmount(answer.text, answer.amount)).toBe(true);
  });

  it("F59: a bare screen link next to the same screen with a period is not a second chip", () => {
    const merged = mergeSources(
      [{ label: "ALV-ilmoitus", href: "/kirjanpito/alv?period=2026-09" }],
      "Katso /kirjanpito/alv."
    );
    expect(merged).toEqual([{ label: "ALV-ilmoitus", href: "/kirjanpito/alv?period=2026-09" }]);
    // A different period is a different place.
    expect(
      mergeSources([{ label: "Kuitit", href: "/kuitit?month=2026-08" }], "/kuitit?month=2026-09")
    ).toHaveLength(2);
  });

  it("reads a euro amount with a space as the thousands separator", () => {
    expect(citedEuroAmounts("ALV 1 234,56 €")).toEqual(["1234.56"]);
    expect(citedEuroAmounts("ALV 12,50 € ja 3.00 €")).toEqual(["12.50", "3.00"]);
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
      { label: "ALV-ilmoitus", href: "/kirjanpito/alv?period=2026-09" },
      { label: "Kuitit", href: "/kuitit?month=2026-09" },
    ]);
  });

  it("recognizes the new ALV path as a bare link", () => {
    expect(
      sourcesFromText("Katso /kirjanpito/alv?period=2026-09 ja /kuitit?month=2026-09.")
    ).toEqual([
      { label: "ALV-ilmoitus", href: "/kirjanpito/alv?period=2026-09" },
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

describe("screen paths in replies", () => {
  it("names a screen instead of showing its address", () => {
    expect(humanizeScreenPaths("Luo lasku täällä: [/laskut/uusi](/laskut/uusi)")).toBe("Luo lasku täällä: [Uusi lasku](/laskut/uusi)");
    expect(humanizeScreenPaths("create one here: /laskut/uusi")).toBe("create one here: [Uusi lasku](/laskut/uusi)");
    expect(humanizeScreenPaths("Katso /kuitit.")).toBe("Katso [Kuitit](/kuitit).");
    expect(humanizeScreenPaths("[Kuitit](/kuitit) ja 1/2 kpl")).toBe("[Kuitit](/kuitit) ja 1/2 kpl");
    expect(humanizeScreenPaths("polku /tuntematon")).toBe("polku /tuntematon");
  });
});

describe("A2: the guard reads every common way of writing euros", () => {
  it.each([
    ["Maksettavaa 999 EUR.", "999.00"],
    ["Maksettavaa 999 €.", "999.00"],
    ["You owe €999.", "999.00"],
    ["You owe € 999.50.", "999.50"],
    ["It was 123.45 euros.", "123.45"],
    ["Summa 123,45 e.", "123.45"],
    ["Summa 123,45e", "123.45"],
    ["Yhteensä 1 234,50 €", "1234.50"],
    ["Yhteensä 1 234,50 €", "1234.50"],
    ["Yhteensä 1.234,50", "1234.50"],
    ["Total 1,234.50", "1234.50"],
    ["Toplam 250 avro", "250.00"],
    ["ALV 12,5 €", "12.50"],
    ["Hinta 40 euroa.", "40.00"],
    ["Summa EUR 75,00", "75.00"],
  ])("%s → %s", (text, amount) => {
    expect(citedEuroAmounts(text)).toEqual([amount]);
  });

  it("does not read a rate, a count, a date or a year as euros", () => {
    expect(citedEuroAmounts("ALV 25,5 % ja 3 eri kuittia 12.10.2026, vuonna 2026.")).toEqual([]);
    expect(citedEuroAmounts("Q3 2026 ja 14 % ruoasta")).toEqual([]);
  });

  it("compares every form against the figures in context", () => {
    const ctx = { ...EMPTY_HONESTY, allowedAmounts: ["999.00", "1234.50"] };
    for (const text of ["999 EUR", "999 €", "€999", "999,00 €", "1 234,50 €", "1.234,50", "1234.5 euros"]) {
      expect(enforceAssistantReply(`Summa: ${text}.`, ctx).rejected, text).toBe(false);
    }
    for (const text of ["998 EUR", "123.45 euros", "123,45 e", "€ 1000", "1.234,51"]) {
      expect(enforceAssistantReply(`Summa: ${text}.`, ctx).reason, text).toBe("amount");
    }
    // A refund's figure is the same number without its sign.
    expect(enforceAssistantReply("Palautus -999,00 €.", ctx).rejected).toBe(false);
  });
});

describe("A2: false action claims in every language", () => {
  it.each([
    "Lähetin laskun asiakkaalle.",
    "Kirjasin kuitin menoksi.",
    "Olen lähettänyt laskun.",
    "I sent the invoice to your customer.",
    "I've booked the receipt.",
    "I have recorded the payment.",
    "Faturayı müşteriye yolladım.",
    "Faturayı gönderdim.",
    "Fişi kaydettim.",
    "Jag skickade fakturan till kunden.",
    "Skickade fakturan i morse.",
    "Jag har bokfört kvittot.",
    "Poistin kuitin.",
    "I deleted the duplicate receipt.",
    "Fişi banka işlemiyle eşleştirdim.",
  ])("rejects %s when nothing was done", (text) => {
    expect(replyClaimsUnperformedAction(text)).toBe(true);
    expect(enforceAssistantReply(text, EMPTY_HONESTY).reason).toBe("unperformed");
  });

  it.each([
    "En ole lähettänyt laskua. Voit lähettää sen Laskut-näkymästä.",
    "I have not sent anything; you can send it from Laskut.",
    "Faturayı göndermedim, Laskut ekranından gönderebilirsin.",
    "Jag har inte skickat fakturan.",
    "Sinulla on kolme lähetettyä laskua.",
    "Du har tre skickade fakturor.",
    "Tarkistin pankkitapahtumasi ja kuitit.",
  ])("lets %s through", (text) => {
    expect(replyClaimsUnperformedAction(text)).toBe(false);
  });

  it("allows only the action the turn performed", () => {
    expect(claimedActionKinds("Lähetin laskun.")).toEqual(["send"]);
    expect(claimedActionKinds("Kirjasin kuitin.")).toEqual(["book"]);
    const sent = { ...EMPTY_HONESTY, performedActions: ["send"] };
    expect(enforceAssistantReply("Lähetin laskun asiakkaalle.", sent).rejected).toBe(false);
    expect(enforceAssistantReply("I sent the invoice.", sent).rejected).toBe(false);
    expect(enforceAssistantReply("Kirjasin kuitin ja lähetin laskun.", sent).reason).toBe("unperformed");
    expect(enforceAssistantReply("Faturayı gönderdim.", { ...EMPTY_HONESTY, performedActions: ["invoice_sent"] }).rejected).toBe(false);
  });
});

describe("A1: the booked VAT answer names the period it is for", () => {
  it("names a month, a quarter or a year, in Finnish, English or Turkish", () => {
    expect(formatBookedVatAnswer({ period: "2026-09", amount: "287.01", isRefund: false, language: "fi" }).text).toBe(
      "Syyskuun ALV: maksettavaa 287,01 €."
    );
    expect(formatBookedVatAnswer({ period: "2025-12", amount: "1.00", isRefund: true, language: "fi", showYear: true }).text).toBe(
      "Joulukuun 2025 ALV: palautusta 1,00 €."
    );
    const quarter = formatBookedVatAnswer({ period: "2026-Q3", amount: "1234.50", isRefund: false, language: "fi" });
    expect(quarter.text).toBe("Q3/2026 ALV: maksettavaa 1 234,50 €.");
    expect(quarter.sources).toEqual([{ label: "ALV-ilmoitus", href: "/kirjanpito/alv?period=2026-Q3" }]);
    expect(formatBookedVatAnswer({ period: "2026", amount: "10.00", isRefund: false, language: "fi" }).text).toMatch(/^Vuoden 2026 ALV/);
    expect(formatBookedVatAnswer({ period: "2026-09", amount: "287.01", isRefund: false, english: true }).text).toBe(
      "VAT for September: 287.01 € to pay."
    );
    expect(formatBookedVatAnswer({ period: "2026-10", amount: "287.01", isRefund: false, language: "tr" }).text).toBe(
      "Ekim KDV: ödenecek 287,01 €."
    );
    // The figure the guard allows is the one in the text, however it is written.
    for (const language of ["fi", "en", "tr"] as const) {
      const answer = formatBookedVatAnswer({ period: "2026-Q3", amount: "1234.50", isRefund: false, language });
      expect(enforceAssistantReply(answer.text, { ...EMPTY_HONESTY, allowedAmounts: [answer.amount] }).rejected).toBe(false);
    }
  });

  it("says which return a month belongs to when the owner files by quarter or year", () => {
    expect(vatReturnNote({ period: "2026-09", ownerKind: "month", language: "fi" })).toBeNull();
    expect(vatReturnNote({ period: "2026-Q3", ownerKind: "quarter", language: "fi" })).toBeNull();
    expect(vatReturnNote({ period: "2026-09", ownerKind: "quarter", language: "fi" })).toBe(
      "ALV-kautesi on neljännesvuosi, joten tämä kuukausi kuuluu kauden Q3/2026 ilmoitukseen."
    );
    expect(vatReturnNote({ period: "2026-Q2", ownerKind: "year", language: "en" })).toBe(
      "Your VAT period is the calendar year, so this quarter is part of the 2026 return."
    );
    expect(vatReturnNote({ period: "2026-09", ownerKind: "quarter", language: "tr" })).toMatch(/2026 3\. çeyrek/);
  });
});
