import { beforeEach, describe, expect, it, vi } from "vitest";
import { reviewMatches } from "./chat-tools-match";
import { createChatToolSession } from "./chat-tools";
import { reviewOpenMatches } from "./match-review-run";
import type { MatchReviewReport, ReviewedMatch } from "./match-review-run";

vi.mock("./match-review-run", () => ({ reviewOpenMatches: vi.fn() }));

const USER = "00000000-0000-4000-8000-000000000001";
const ctx = { userId: USER, now: new Date("2026-10-03T09:00:00.000Z") };

/** Stable uuids: the tool's result feeds the chat's id/href ledger, which only
 *  accepts real-looking ids. */
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** `count` confidently matchable receipt pairs, all certain (viite + amount). */
function certainMatch(i: number): ReviewedMatch {
  return {
    target: "receipt",
    transactionId: uuid(i + 1),
    candidateId: uuid(100 + i),
    status: "certain",
    passed: true,
    score: 1,
    confidence: null,
    reasons: ["viite täsmää", "summa sama"],
    row: { date: new Date("2026-09-05"), amountCents: -12_300 - i, counterparty: "MYYJÄ OY", message: null },
    candidate: { label: `Kuitti ${i}`, date: new Date("2026-09-04"), amountCents: 12_300 + i, fileName: `k${i}.pdf`, invoiceNumber: null },
  };
}

function reportWith(count: number, ambiguousRows = 0): MatchReviewReport {
  return {
    aiAvailable: false,
    matches: Array.from({ length: count }, (_, i) => certainMatch(i)),
    ambiguous: Array.from({ length: ambiguousRows }, (_, i) => ({
      target: "receipt" as const,
      transactionId: uuid(300 + i),
      row: { date: new Date("2026-09-06"), amountCents: -500, counterparty: "KAHVILA LUMO" },
      options: [
        { candidateId: uuid(500), label: "Kahvila Lumo A", reasons: ["summa sama"] },
        { candidateId: uuid(501), label: "Kahvila Lumo B", reasons: ["summa sama"] },
      ],
    })),
    reviewedNow: 0,
    fromCache: 0,
    unreviewed: 0,
  };
}

async function run(count: number, ambiguousRows = 0) {
  vi.mocked(reviewOpenMatches).mockResolvedValue(reportWith(count, ambiguousRows));
  return reviewMatches.run(ctx, {});
}

beforeEach(() => {
  vi.mocked(reviewOpenMatches).mockReset();
});

describe("review_matches lists every confident match", () => {
  it("returns all N passed pairs and an honest total, not one and not ten", async () => {
    const result = await run(25);
    expect(result.ok).toBe(true);
    // The model reads the first rows only; the real total and every card stay complete.
    expect(result.passed).toHaveLength(20);
    expect(result.passedTotal).toBe(25);
    expect(result.truncated).toBe(true);
    expect((result.batch as { pairs: unknown[] }).pairs).toHaveLength(25);
    expect(result.batch).toMatchObject({ count: 25, ambiguous: 0, href: "/api/matching/confirm-all" });
    // One card per passed pair, and the reply stores them as one batch card.
    expect(result.cards).toHaveLength(25);
    expect(result.proposal).toMatchObject({ type: "match_batch", confident: 25, ambiguous: 0 });
    expect((result.proposal as { pairs: unknown[] }).pairs).toHaveLength(25);
  });

  it("keeps going past the old cap of ten and still reports the real total when truncated", async () => {
    const result = await run(51);
    expect(result.passed).toHaveLength(20);
    expect(result.passedTotal).toBe(51);
    expect(result.truncated).toBe(true);
    expect((result.batch as { pairs: unknown[] }).pairs).toHaveLength(51);
    // The card list is capped like the text list; the accept-all still covers every confident pair.
    expect(result.cards).toHaveLength(50);
    expect(result.proposal).toMatchObject({ type: "match_batch", confident: 51, truncated: true });
  });

  it("never proposes an ambiguous row and counts it for the owner", async () => {
    const result = await run(3, 1);
    const passed = result.passed as Array<{ match: { id: string } }>;
    const proposed = new Set(passed.map((m) => m.match.id));
    expect(proposed.has(uuid(500))).toBe(false);
    expect(proposed.has(uuid(501))).toBe(false);
    const batchIds = new Set((result.batch as { pairs: Array<{ receiptId: string }> }).pairs.map((p) => p.receiptId));
    expect(batchIds.has(uuid(500))).toBe(false);
    expect(batchIds.has(uuid(501))).toBe(false);
    expect(result.batch).toMatchObject({ count: 3, ambiguous: 1 });
    const ambiguous = result.ambiguous as Array<{ options: unknown[] }>;
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0].options).toHaveLength(2);
  });

  it("says one when only one pair passed, without padding", async () => {
    const result = await run(1);
    expect(result.passedTotal).toBe(1);
    expect(result.truncated).toBe(false);
    expect(result.passed).toHaveLength(1);
    expect((result.batch as { pairs: unknown[] }).pairs).toHaveLength(1);
    // A lone pair keeps the plain proposal card.
    expect(result.cards).toHaveLength(1);
    expect(result.proposal).toMatchObject({ type: "match_proposal", receiptId: uuid(100) });
  });
});

describe("review_matches returns every proposal as a card", () => {
  it("3 confident + 1 ambiguous -> 4 cards, batch of 3, the ambiguous one flagged and outside the pairs", async () => {
    const result = await run(3, 1);
    const cards = result.cards as Array<{ ambiguous: boolean; receiptId: string | null; transactionId: string; options?: unknown[] }>;
    expect(cards).toHaveLength(4);
    expect(cards.filter((card) => card.ambiguous)).toHaveLength(1);
    expect(cards.filter((card) => !card.ambiguous).every((card) => card.receiptId)).toBe(true);
    const ambiguousCard = cards.find((card) => card.ambiguous)!;
    expect(ambiguousCard.receiptId).toBeNull();
    expect(ambiguousCard.options).toHaveLength(2);
    expect(result.batch).toMatchObject({ count: 3, ambiguous: 1 });
    const pairIds = new Set((result.batch as { pairs: Array<{ transactionId: string }> }).pairs.map((pair) => pair.transactionId));
    expect(pairIds.has(ambiguousCard.transactionId)).toBe(false);
    expect(result.proposal).toMatchObject({ type: "match_batch", confident: 3, ambiguous: 1 });
  });

  it("a review with only ambiguous rows still shows them as cards", async () => {
    const result = await run(0, 2);
    expect(result.cards).toHaveLength(2);
    expect(result.proposal).toMatchObject({ type: "match_batch", confident: 0, ambiguous: 2 });
  });

  it("nothing passed and nothing ambiguous -> no card and no proposal", async () => {
    const result = await run(0, 0);
    expect(result.cards).toEqual([]);
    expect(result.proposal).toBeUndefined();
  });

  it("the model sees the compact list, the owner's screen gets the cards, and 50 rows fit the result cap", async () => {
    vi.mocked(reviewOpenMatches).mockResolvedValue(reportWith(60, 2));
    const session = createChatToolSession(USER, ctx.now);
    const text = await session.run("review_matches", "{}");
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed, text.slice(0, 200)).toMatchObject({ ok: true });
    expect(parsed.cards).toBeUndefined();
    expect(parsed.proposal).toBeUndefined();
    expect(parsed.batch).toMatchObject({ count: 60, ambiguous: 2 });
    expect((parsed.batch as { pairs?: unknown }).pairs).toBeUndefined();
    expect(text.length).toBeLessThan(12_000);
    expect(session.proposal()).toMatchObject({ type: "match_batch", confident: 60, ambiguous: 2 });
  });
});
