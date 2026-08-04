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
  it("auto-confirms viite matches at threshold", () => {
    expect(shouldAutoConfirm(0.9, ["viite", "amount"])).toBe(true);
  });
  it("auto-confirms amount+vendor strong matches", () => {
    expect(shouldAutoConfirm(0.88, ["amount", "vendor", "date"])).toBe(true);
  });
  it("does not auto-confirm weak vendor-only picks", () => {
    expect(shouldAutoConfirm(0.6, ["vendor"])).toBe(false);
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
