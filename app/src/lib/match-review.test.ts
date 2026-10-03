import { describe, expect, it, vi } from "vitest";
import {
  acceptVerdict,
  parseVerdict,
  REVIEW_ACCEPT_CONFIDENCE,
  reviewCases,
  reviewKey,
  reviewUserMessage,
  type MatchJudge,
  type ReviewCache,
  type ReviewCase,
  type StoredReview,
} from "./match-review";

function reviewCase(overrides: Partial<ReviewCase> = {}): ReviewCase {
  return {
    target: "receipt",
    row: { id: "row-1", date: "2026-08-12", amount: "-49.90", counterparty: "PUHELINFIRMA", message: null, reference: null },
    candidates: [
      { id: "r-1", kind: "kuitti", date: "2026-08-10", dueDate: null, amount: "49.90", open: null, party: "Puhelinfirma Oy", reference: null, invoiceNumber: null, gateReasons: ["summa sama", "nimi vastaa"] },
      { id: "r-2", kind: "kuitti", date: "2026-08-03", dueDate: null, amount: "49.90", open: null, party: "Puhelinfirma Oy", reference: null, invoiceNumber: null, gateReasons: ["summa sama"] },
    ],
    gatePickId: "r-1",
    ...overrides,
  };
}

function memoryCache(): ReviewCache & { store: Map<string, StoredReview> } {
  const store = new Map<string, StoredReview>();
  return {
    store,
    async get(keys) {
      return new Map(keys.filter((k) => store.has(k)).map((k) => [k, store.get(k)!]));
    },
    async put(_item, key, review) {
      store.set(key, review);
    },
  };
}

function judgeSaying(answer: unknown, options: { reasoning?: boolean } = {}): MatchJudge & { calls: Array<{ system: string; user: string }> } {
  const calls: Array<{ system: string; user: string }> = [];
  const judge = (async (system: string, user: string) => {
    calls.push({ system, user });
    return { text: typeof answer === "string" ? answer : JSON.stringify(answer), model: "gemini-test", reasoning: options.reasoning ?? true };
  }) as MatchJudge & { calls: typeof calls };
  judge.calls = calls;
  return judge;
}

describe("parseVerdict", () => {
  it("reads strict JSON, fenced or bare, and keeps up to three clean Finnish reasons", () => {
    const text = "```json\n{\"match\":\"r-1\",\"confidence\":0.92,\"reasons\":[\"summa sama\",\"nimi vastaa\",\"<b>veloitettu</b> 2 päivää oston jälkeen\",\"neljäs\"]}\n```";
    expect(parseVerdict(text, ["r-1", "r-2"])).toEqual({
      match: "r-1",
      confidence: 0.92,
      reasons: ["summa sama", "nimi vastaa", "b veloitettu /b 2 päivää oston jälkeen"],
    });
  });

  it("refuses prose, a confidence out of range and a pick that was not offered", () => {
    expect(parseVerdict("I think r-1 matches.", ["r-1"])).toBeNull();
    expect(parseVerdict('{"match":"r-1","confidence":1.7,"reasons":[]}', ["r-1"])).toBeNull();
    expect(parseVerdict('{"match":"someone-else","confidence":0.99,"reasons":[]}', ["r-1"])).toBeNull();
    expect(parseVerdict('{"match":null,"confidence":0.9,"reasons":["eri saaja"]}', ["r-1"])).toMatchObject({ match: null });
  });
});

describe("acceptVerdict", () => {
  it("accepts only the gate's own pick at or above the threshold", () => {
    const item = reviewCase();
    expect(acceptVerdict(item, { match: "r-1", confidence: REVIEW_ACCEPT_CONFIDENCE, reasons: [] })).toBe(true);
    expect(acceptVerdict(item, { match: "r-1", confidence: 0.79, reasons: [] })).toBe(false);
    expect(acceptVerdict(item, { match: "r-2", confidence: 0.99, reasons: [] })).toBe(false);
    expect(acceptVerdict(item, { match: null, confidence: 0.99, reasons: [] })).toBe(false);
  });
});

describe("reviewCases with a fake provider", () => {
  it("an agreeing, confident pick is accepted and cached; the next run asks nothing", async () => {
    const cache = memoryCache();
    const judge = judgeSaying({ match: "r-1", confidence: 0.9, reasons: ["sama operaattori"] });
    const [outcome] = await reviewCases([reviewCase()], { judge, cache });
    expect(outcome).toMatchObject({ status: "accepted", fromCache: false });
    expect(outcome.review).toMatchObject({ accepted: true, confidence: 0.9, reasons: ["sama operaattori"], model: "gemini-test", reasoning: true });
    expect(judge.calls).toHaveLength(1);
    // The prompt carries the row and the candidates as data, and asks for strict JSON.
    expect(judge.calls[0].system).toMatch(/JSON object only/);
    expect(JSON.parse(judge.calls[0].user).candidates.map((c: { id: string }) => c.id)).toEqual(["r-1", "r-2"]);

    const again = await reviewCases([reviewCase()], { judge, cache });
    expect(again[0]).toMatchObject({ status: "accepted", fromCache: true });
    expect(judge.calls).toHaveLength(1);
  });

  it("a disagreeing pick vetoes the suggestion", async () => {
    const [outcome] = await reviewCases([reviewCase()], { judge: judgeSaying({ match: "r-2", confidence: 0.95, reasons: ["päivä sopii paremmin"] }), cache: memoryCache() });
    expect(outcome.status).toBe("rejected");
    expect(outcome.review?.accepted).toBe(false);
  });

  it("a low-confidence or null answer vetoes too", async () => {
    const low = await reviewCases([reviewCase()], { judge: judgeSaying({ match: "r-1", confidence: 0.6, reasons: [] }), cache: memoryCache() });
    expect(low[0].status).toBe("rejected");
    const none = await reviewCases([reviewCase()], { judge: judgeSaying({ match: null, confidence: 0.9, reasons: ["eri saaja"] }), cache: memoryCache() });
    expect(none[0].status).toBe("rejected");
  });

  it("a provider without reasoning still works", async () => {
    const [outcome] = await reviewCases([reviewCase()], {
      judge: judgeSaying({ match: "r-1", confidence: 0.85, reasons: [] }, { reasoning: false }),
      cache: memoryCache(),
    });
    expect(outcome.status).toBe("accepted");
    expect(outcome.review?.reasoning).toBe(false);
  });

  it("garbage or a failed call leaves the case unreviewed and uncached", async () => {
    const cache = memoryCache();
    const garbage = await reviewCases([reviewCase()], { judge: judgeSaying("sorry, cannot"), cache });
    expect(garbage[0].status).toBe("unreviewed");
    const failing: MatchJudge = async () => {
      throw new Error("quota");
    };
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const failed = await reviewCases([reviewCase()], { judge: failing, cache });
    expect(failed[0].status).toBe("unreviewed");
    expect(cache.store.size).toBe(0);
    vi.restoreAllMocks();
  });

  it("without a judge nothing is asked and cached verdicts still apply", async () => {
    const cache = memoryCache();
    await reviewCases([reviewCase()], { judge: judgeSaying({ match: "r-2", confidence: 0.9, reasons: [] }), cache });
    const offline = await reviewCases([reviewCase(), reviewCase({ row: { ...reviewCase().row, id: "row-2" } })], { judge: null, cache });
    expect(offline.map((o) => o.status)).toEqual(["rejected", "unreviewed"]);
  });

  it("keeps to the call budget and the concurrency limit", async () => {
    let running = 0;
    let peak = 0;
    const judge: MatchJudge = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return { text: '{"match":"r-1","confidence":0.9,"reasons":[]}', model: null, reasoning: false };
    };
    const cases = Array.from({ length: 6 }, (_, i) => reviewCase({ row: { ...reviewCase().row, id: `row-${i}` } }));
    const outcomes = await reviewCases(cases, { judge, cache: memoryCache(), maxCalls: 4, concurrency: 2 });
    expect(outcomes.filter((o) => o.status === "accepted")).toHaveLength(4);
    expect(outcomes.filter((o) => o.status === "unreviewed")).toHaveLength(2);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("reviewKey", () => {
  it("changes when the candidate set or the row changes, not with candidate order", () => {
    const base = reviewCase();
    expect(reviewKey({ ...base, candidates: [...base.candidates].reverse() })).toBe(reviewKey(base));
    expect(reviewKey({ ...base, candidates: base.candidates.slice(0, 1) })).not.toBe(reviewKey(base));
    expect(reviewKey({ ...base, row: { ...base.row, message: "toinen" } })).not.toBe(reviewKey(base));
  });

  it("sends at most three candidates", () => {
    const many = reviewCase({
      candidates: Array.from({ length: 5 }, (_, i) => ({ ...reviewCase().candidates[0], id: `r-${i}` })),
    });
    expect(JSON.parse(reviewUserMessage(many)).candidates).toHaveLength(3);
  });
});
