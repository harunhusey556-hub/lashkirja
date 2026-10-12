import { beforeEach, describe, expect, it, vi } from "vitest";
import { reviewMatches } from "./chat-tools-match";
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
    expect(result.passed).toHaveLength(25);
    expect(result.passedTotal).toBe(25);
    expect(result.truncated).toBe(false);
    expect((result.batch as { pairs: unknown[] }).pairs).toHaveLength(25);
    expect(result.batch).toMatchObject({ count: 25, ambiguous: 0, href: "/api/matching/confirm-all" });
    // The single best card stays for the reply; the batch carries the whole set.
    expect(result.proposal).toMatchObject({ type: "match_proposal", receiptId: uuid(100) });
  });

  it("keeps going past the old cap of ten and still reports the real total when truncated", async () => {
    const result = await run(51);
    expect(result.passed).toHaveLength(50);
    expect(result.passedTotal).toBe(51);
    expect(result.truncated).toBe(true);
    expect((result.batch as { pairs: unknown[] }).pairs).toHaveLength(51);
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
    expect(result.passed).toHaveLength(1);
    expect((result.batch as { pairs: unknown[] }).pairs).toHaveLength(1);
  });
});
