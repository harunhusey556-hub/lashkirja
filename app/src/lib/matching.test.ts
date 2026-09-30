import { describe, it, expect } from "vitest";
import {
  scorePair,
  computeSuggestions,
  candidatesFor,
  normalizeRef,
  nameSimilarity,
  SUGGEST_THRESHOLD,
  CANDIDATE_THRESHOLD,
  shouldAutoConfirm,
  sourceDraftPairs,
  isSourceDraft,
  type MatchTx,
  type MatchReceipt,
} from "./matching";

function tx(overrides: Partial<MatchTx> = {}): MatchTx {
  return {
    id: "tx1",
    date: new Date("2026-08-10"),
    counterparty: "Puhelinfirma Oy",
    amount: -49.9,
    reference: null,
    message: null,
    type: "meno",
    ...overrides,
  };
}

function receipt(overrides: Partial<MatchReceipt> = {}): MatchReceipt {
  return {
    id: "r1",
    vendor: "Puhelinfirma Oy",
    date: new Date("2026-08-10"),
    totalAmount: 49.9,
    type: "meno",
    reference: null,
    invoiceNumber: null,
    ...overrides,
  };
}

describe("normalizeRef", () => {
  it("strips spaces and leading zeros", () => {
    expect(normalizeRef("00 123 456")).toBe("123456");
  });
  it("reduces RF reference to the underlying viite", () => {
    expect(normalizeRef("RF18 1009")).toBe("1009");
  });
  it("rejects empty and too-short values", () => {
    expect(normalizeRef("")).toBeNull();
    expect(normalizeRef("0")).toBeNull();
    expect(normalizeRef(null)).toBeNull();
  });
});

describe("nameSimilarity", () => {
  it("ignores legal suffixes and case", () => {
    expect(nameSimilarity("puhelinfirma oy", "PUHELINFIRMA")).toBe(1);
  });
  it("returns 0 when nothing shared", () => {
    expect(nameSimilarity("Vuokranantaja", "K-Market")).toBe(0);
  });
});

describe("scorePair", () => {
  it("exact viite match suggests even without vendor or date", () => {
    const result = scorePair(
      tx({ reference: "1009", counterparty: null, date: null }),
      receipt({ reference: "RF18 1009", vendor: null, date: null })
    );
    expect(result!.reasons).toContain("viite");
    expect(result!.reasons).toContain("amount");
    expect(result!.score).toBeGreaterThanOrEqual(SUGGEST_THRESHOLD);
  });

  it("viite+amount with 21-day gap still suggests (invoice payment terms)", () => {
    const result = scorePair(
      tx({ reference: "5005", date: new Date("2026-08-31") }),
      receipt({ reference: "5005", date: new Date("2026-08-10") })
    );
    expect(result!.score).toBeGreaterThanOrEqual(SUGGEST_THRESHOLD);
  });

  it("amount+vendor near date suggests", () => {
    const result = scorePair(
      tx({ date: new Date("2026-08-12") }),
      receipt({ date: new Date("2026-08-10") })
    );
    expect(result!.reasons).toEqual(
      expect.arrayContaining(["amount", "vendor", "date"])
    );
    expect(result!.score).toBeGreaterThanOrEqual(SUGGEST_THRESHOLD);
  });

  it("date-only proximity is not even a candidate", () => {
    const result = scorePair(
      tx({ amount: -10, counterparty: "Joku Muu" }),
      receipt({ totalAmount: 999 })
    );
    expect(result!.score).toBeLessThan(CANDIDATE_THRESHOLD);
  });

  it("palkka never matches", () => {
    expect(scorePair(tx({ type: "palkka" }), receipt())).toBeNull();
  });

  it("oma_siirto never matches", () => {
    expect(scorePair(tx({ type: "oma_siirto" }), receipt())).toBeNull();
  });

  it("tulo receipt never matches meno transaction", () => {
    expect(scorePair(tx({ type: "meno" }), receipt({ type: "tulo" }))).toBeNull();
  });
});

describe("shouldAutoConfirm", () => {
  it("auto-confirms an exact reference plus an exact amount", () => {
    expect(shouldAutoConfirm(0.9, ["viite", "amount"])).toBe(true);
  });

  // Regression guard. This combination used to auto-post, but `date` is pushed
  // for any proximity inside a 35-day window, so it amounted to "same amount,
  // same month" — two identical MobilePay rows would link to whichever receipt
  // sorted first and silently enter the ALV report.
  it("does not auto-confirm amount + vendor + date without a reference", () => {
    expect(shouldAutoConfirm(0.88, ["amount", "vendor", "date"])).toBe(false);
  });

  it("does not auto-confirm a reference without a matching amount", () => {
    expect(shouldAutoConfirm(0.9, ["viite", "date"])).toBe(false);
  });

  it("does not auto-confirm weak vendor-only picks", () => {
    expect(shouldAutoConfirm(0.6, ["vendor"])).toBe(false);
  });

  it("refuses to auto-confirm when a rival candidate existed", () => {
    expect(shouldAutoConfirm(0.95, ["viite", "amount", "competing"])).toBe(false);
  });

  it("still respects the score floor", () => {
    expect(shouldAutoConfirm(0.5, ["viite", "amount"])).toBe(false);
  });
});

describe("computeSuggestions", () => {
  it("rejected pair is not re-suggested", () => {
    const result = computeSuggestions(
      [tx()],
      [receipt()],
      new Set(["tx1:r1"])
    );
    expect(result).toHaveLength(0);
  });

  it("one receipt vs two candidate rows: greedy picks the higher score", () => {
    const strong = tx({ id: "txA" }); // same day
    const weaker = tx({ id: "txB", date: new Date("2026-08-13") }); // 3 days off
    const result = computeSuggestions([weaker, strong], [receipt()], new Set());
    expect(result).toHaveLength(1);
    expect(result[0].transactionId).toBe("txA");
  });

  it("flags the winner as competing when a rival scored plausibly", () => {
    const strong = tx({ id: "txA" });
    const weaker = tx({ id: "txB", date: new Date("2026-08-13") });
    const [winner] = computeSuggestions([weaker, strong], [receipt()], new Set());
    // The rival exists, so however good the winner looks it must not auto-post.
    expect(winner.reasons).toContain("competing");
    expect(shouldAutoConfirm(winner.score, winner.reasons)).toBe(false);
  });

  it("leaves an unambiguous pair unflagged so it can still auto-post", () => {
    const only = tx({ id: "txA", reference: "123456", amount: -49.9 });
    const [winner] = computeSuggestions(
      [only],
      [receipt({ reference: "123456" })],
      new Set()
    );
    expect(winner.reasons).not.toContain("competing");
    expect(winner.reasons).toContain("viite");
    expect(shouldAutoConfirm(winner.score, winner.reasons)).toBe(true);
  });

  it("two receipts, two txs: both get their own match", () => {
    const txs = [
      tx({ id: "txA", amount: -49.9 }),
      tx({ id: "txB", amount: -120, counterparty: "Vuokranantaja Ky" }),
    ];
    const receipts = [
      receipt({ id: "rA" }),
      receipt({ id: "rB", vendor: "Vuokranantaja", totalAmount: 120 }),
    ];
    const result = computeSuggestions(txs, receipts, new Set());
    expect(result).toHaveLength(2);
    const byTx = Object.fromEntries(
      result.map((p) => [p.transactionId, p.receiptId])
    );
    expect(byTx.txA).toBe("rA");
    expect(byTx.txB).toBe("rB");
  });
});

describe("candidatesFor", () => {
  it("returns scored shortlist sorted by score, skipping rejected", () => {
    const receipts = [
      receipt({ id: "good" }),
      receipt({ id: "meh", date: new Date("2026-08-14"), vendor: null }),
      receipt({ id: "rejected" }),
    ];
    const result = candidatesFor(tx(), receipts, new Set(["tx1:rejected"]));
    expect(result.map((c) => c.receiptId)).toEqual(["good", "meh"]);
    expect(result[0].score).toBeGreaterThan(result[1].score);
  });
});

describe("sourceDraftPairs", () => {
  const rows = [{ id: "tx-1" }, { id: "tx-2" }];
  const drafts = [
    { id: "r-1", source: "auto_income", sourceTransactionId: "tx-1" },
    { id: "r-2", source: "auto_income", sourceTransactionId: "tx-9" },
    { id: "r-3", source: "manual", sourceTransactionId: null },
  ];

  it("pairs an income draft only with the bank row it was made from", () => {
    expect(sourceDraftPairs(rows, drafts, new Set())).toEqual([
      { transactionId: "tx-1", receiptId: "r-1", score: 1, reasons: ["auto_income"] },
    ]);
  });

  it("drops a pair the owner rejected with Ei ole myyntiä", () => {
    expect(sourceDraftPairs(rows, drafts, new Set(["tx-1:r-1"]))).toEqual([]);
  });

  it("keeps drafts out of every other row's candidates", () => {
    expect(isSourceDraft(drafts[0])).toBe(true);
    expect(isSourceDraft(drafts[2])).toBe(false);
    expect(isSourceDraft({ source: "auto_income", sourceTransactionId: null })).toBe(false);
  });
});
