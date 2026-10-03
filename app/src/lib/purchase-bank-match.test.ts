import { describe, expect, it } from "vitest";
import {
  feeDifferenceCents,
  matchesPurchaseSearch,
  rankPurchasePairs,
  scorePurchasePair,
  type PurchaseBankRow,
  type PurchaseSide,
} from "./purchase-bank-match";

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

const invoice = (overrides: Partial<PurchaseSide> = {}): PurchaseSide => ({
  id: "inv",
  supplierName: "Tukku Oy",
  supplierIban: null,
  reference: null,
  invoiceNumber: null,
  issueDate: day("2026-01-10"),
  dueDate: day("2026-01-24"),
  grossCents: 124_00,
  openCents: 124_00,
  ...overrides,
});

const row = (overrides: Partial<PurchaseBankRow> = {}): PurchaseBankRow => ({
  id: "row",
  date: day("2026-01-25"),
  amountCents: -124_00,
  counterparty: "Tukku Oy",
  reference: null,
  message: null,
  ...overrides,
});

describe("feeDifferenceCents", () => {
  it("allows 2 € or 0.5 %, whichever is larger, and nothing for an exact amount", () => {
    expect(feeDifferenceCents(124_00, invoice())).toBeNull();
    expect(feeDifferenceCents(126_00, invoice())).toBe(2_00);
    expect(feeDifferenceCents(122_00, invoice())).toBe(-2_00);
    expect(feeDifferenceCents(126_01, invoice())).toBeNull();
    // 0.5 % of 10 000 € is 50 €.
    expect(feeDifferenceCents(10_040_00, invoice({ grossCents: 10_000_00, openCents: 10_000_00 }))).toBe(40_00);
    // Against the open amount once part is paid.
    expect(feeDifferenceCents(25_00, invoice({ openCents: 24_00 }))).toBe(1_00);
  });
});

describe("scorePurchasePair", () => {
  it("exact amount + the supplier's name is a strong pair with Finnish reasons", () => {
    const score = scorePurchasePair(row(), invoice());
    expect(score.exactAmount).toBe(true);
    expect(score.amountDiffCents).toBeNull();
    expect(score.eligible).toBe(true);
    expect(score.score).toBeGreaterThanOrEqual(0.7);
    expect(score.reasons).toEqual(["summa sama", "nimi vastaa", "maksettu 1 päivä eräpäivän jälkeen"]);
  });

  it("flags a fee difference and ranks it under the exact amount but over an amount alone", () => {
    const fee = scorePurchasePair(row({ amountCents: -126_00 }), invoice());
    const exact = scorePurchasePair(row(), invoice());
    const amountOnly = scorePurchasePair(row({ counterparty: "Joku Muu" }), invoice());
    const nameOnly = scorePurchasePair(row({ amountCents: -50_00 }), invoice());
    expect(fee.amountDiffCents).toBe(2_00);
    expect(fee.reasons[0]).toMatch(/^summa poikkeaa 2,00\s€$/u);
    expect(fee.score).toBeLessThan(exact.score);
    expect(fee.score).toBeGreaterThan(amountOnly.score);
    expect(amountOnly.score).toBeGreaterThan(nameOnly.score);
    expect(nameOnly.score).toBeGreaterThan(0);
  });

  it("a stranger with another amount scores nothing", () => {
    const score = scorePurchasePair(row({ counterparty: "Joku Muu", amountCents: -9_00 }), invoice());
    expect(score.score).toBe(0);
    expect(score.reasons).toEqual(["maksettu 1 päivä eräpäivän jälkeen"]);
  });
});

describe("rankPurchasePairs", () => {
  it("orders by score, then by closeness to the due date", () => {
    const rows = [
      row({ id: "late", counterparty: "X", amountCents: -1_00, date: day("2026-03-30") }),
      row({ id: "near", counterparty: "X", amountCents: -1_00, date: day("2026-01-23") }),
      row({ id: "best" }),
    ];
    const ranked = rankPurchasePairs(rows.map((r) => ({ row: r, invoice: invoice(), item: r.id })));
    expect(ranked.map((entry) => entry.item)).toEqual(["best", "near", "late"]);
  });
});

describe("matchesPurchaseSearch", () => {
  it("matches names and messages without case, and amounts typed either way", () => {
    expect(matchesPurchaseSearch("tukku", ["Tukku Oy", null], -124_50)).toBe(true);
    expect(matchesPurchaseSearch("124,5", ["X"], -124_50)).toBe(true);
    expect(matchesPurchaseSearch("124.50", ["X"], -124_50)).toBe(true);
    expect(matchesPurchaseSearch("124,50 €", ["X"], -124_50)).toBe(true);
    expect(matchesPurchaseSearch("125", ["X"], -124_50)).toBe(false);
    expect(matchesPurchaseSearch("  ", ["X"], 0)).toBe(true);
  });
});
