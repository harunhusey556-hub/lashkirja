import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatMatchBatch, MatchCard } from "@/lib/chat-match-batch";
import { batchButtonLabel, batchHeader, batchResultText, MatchBatchCard } from "./MatchBatchCard";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function confident(i: number): MatchCard {
  return {
    transactionId: uuid(i + 1),
    receiptId: uuid(100 + i),
    bankRow: { date: "2026-09-05", amountCents: -12_300 - i, counterparty: `MYYJÄ ${i}`, href: "/pankki/tapahtumat" },
    receipt: { label: `Kuitti ${i}`, date: "2026-09-04", amountCents: 12_300 + i, href: "/kuitit/kuitti" },
    reasons: ["viite täsmää", "summa sama"],
    confidence: 0.92,
    status: "certain",
    ambiguous: false,
  };
}

function ambiguousCard(i: number): MatchCard {
  return {
    transactionId: uuid(300 + i),
    receiptId: null,
    bankRow: { date: "2026-09-06", amountCents: -500, counterparty: "KAHVILA LUMO", href: "/pankki/tapahtumat" },
    receipt: null,
    reasons: [],
    confidence: null,
    status: "ambiguous",
    ambiguous: true,
    options: [
      { receiptId: uuid(500), label: "Kahvila Lumo A", reasons: [] },
      { receiptId: uuid(501), label: "Kahvila Lumo B", reasons: [] },
    ],
  };
}

function batchOf(confidentCount: number, ambiguousCount: number): ChatMatchBatch {
  const sure = Array.from({ length: confidentCount }, (_, i) => confident(i));
  return {
    type: "match_batch",
    cards: [...sure, ...Array.from({ length: ambiguousCount }, (_, i) => ambiguousCard(i))],
    confident: confidentCount,
    ambiguous: ambiguousCount,
    truncated: false,
    pairs: sure.map((card) => ({ transactionId: card.transactionId, receiptId: card.receiptId! })),
  };
}

const render = (batch: ChatMatchBatch) => renderToStaticMarkup(createElement(MatchBatchCard, { batch }));

describe("the chat's batch match card", () => {
  it("heads the list with the counts and offers one accept-all with the count of confident pairs", () => {
    const html = render(batchOf(3, 1));
    expect(html).toContain("4 kohdistusehdotusta · 3 varmaa · 1 epäselvä");
    expect(html).toContain("Hyväksy kaikki varmat (3)");
  });

  it("lists each confident row with receipt, bank row, amount, date and confidence, and a per-row Hyväksy / Hylkää", () => {
    const html = render(batchOf(2, 0));
    expect(html).toContain("Kuitti 0 → MYYJÄ 0");
    expect(html).toMatch(/123,00\s€/);
    expect(html).toContain("5.9.2026");
    expect(html).toContain("92 %");
    expect(html.match(/>Hyväksy</g)).toHaveLength(2);
    expect(html.match(/>Hylkää</g)).toHaveLength(2);
  });

  it("leaves an ambiguous row to a per-row choice: its options, no Hyväksy / Hylkää, not counted in the button", () => {
    const html = render(batchOf(0, 1));
    expect(html).toContain("Kahvila Lumo A");
    expect(html).toContain("Kahvila Lumo B");
    expect(html).toContain("valitse itse");
    expect(html).not.toContain(">Hyväksy<");
    expect(html).toContain("Hyväksy kaikki varmat (0)");
  });

  it("disables the accept-all button when no confident pair is left", () => {
    const html = render(batchOf(0, 2));
    const button = html.match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Hyväksy kaikki varmat \(0\)/)?.[0] ?? "";
    expect(button).toContain('disabled=""');
    // With pairs left no button in the card is disabled.
    expect(render(batchOf(3, 0))).not.toContain('disabled=""');
  });
});

describe("batch card text", () => {
  it("writes Finnish singulars and the result line", () => {
    expect(batchHeader({ confident: 1, ambiguous: 0 })).toBe("1 kohdistusehdotus · 1 varma · 0 epäselvää");
    expect(batchHeader({ confident: 5, ambiguous: 2 })).toBe("7 kohdistusehdotusta · 5 varmaa · 2 epäselvää");
    expect(batchButtonLabel(12)).toBe("Hyväksy kaikki varmat (12)");
    expect(batchResultText({ confirmed: 4, skipped: 1, alreadyConfirmed: 0 })).toBe("Hyväksytty 4 · epäonnistui 1");
    expect(batchResultText({ confirmed: 0, skipped: 0, alreadyConfirmed: 5 })).toBe("Hyväksytty 0 · epäonnistui 0 · aiemmin hyväksytty 5");
  });
});
