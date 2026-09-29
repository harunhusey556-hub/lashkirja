import { describe, expect, it } from "vitest";
import { nextVatDue, vatDueFor, vatPeriodEndingIn, vatPeriodKey, vatPeriodKindOf } from "./vat-deadline";
import {
  vatChangedSinceFiling,
  vatDueAmount,
  vatDueSecondary,
  vatFilingState,
  vatPendingNote,
  vatStateLabel,
  type VatDueFigures,
} from "./vat-due";

const august: VatDueFigures = { amount: 159.38, isRefund: false, filing: null, pendingReceiptCount: 0 };

describe("next VAT due (TF-01)", () => {
  it("in late September a monthly filer's next return is August, due 12.10.", () => {
    const due = nextVatDue(new Date("2026-09-30T10:00:00Z"), "month");
    expect(due.key).toBe("2026-08");
    expect(due.label).toBe("Elokuu 2026");
    expect(due.dueIso).toBe("2026-10-12");
    expect(due.queryKey).toBe("2026-08");
  });

  it("the row reads the same on every screen", () => {
    const due = nextVatDue(new Date("2026-09-30T10:00:00Z"), "month");
    expect(vatDueSecondary(due, august)).toBe("Elokuu 2026 · eräpäivä 12.10. · Ilmoittamatta");
    expect(vatDueAmount(august)).toBe("159,38 €");
    expect(vatDueSecondary(due, null)).toBe("Elokuu 2026 · eräpäivä 12.10.");
  });

  it("a refund says so and needs no payment", () => {
    const due = vatDueFor({ kind: "month", year: 2026, month: 9 });
    const refund = { ...august, isRefund: true, filing: { filedAt: "2026-10-05T00:00:00Z", paidAt: null, filedAmount: -20.8 } };
    expect(vatDueSecondary(due, refund)).toBe("Syyskuu 2026 · palautus · eräpäivä 12.11. · Ilmoitettu");
  });

  it("names the filing state", () => {
    expect(vatFilingState(null)).toBe("open");
    expect(vatFilingState({ filedAt: "x", paidAt: null, filedAmount: 1 })).toBe("filed");
    expect(vatFilingState({ filedAt: "x", paidAt: "y", filedAmount: 1 })).toBe("paid");
    expect(vatStateLabel("filed", false)).toBe("Ilmoitettu, maksamatta");
    expect(vatStateLabel("paid", false)).toBe("Maksettu");
  });

  it("keys and kinds", () => {
    expect(vatPeriodKey({ kind: "quarter", year: 2026, quarter: 3 })).toBe("2026-Q3");
    expect(vatPeriodKey({ kind: "year", year: 2026 })).toBe("2026");
    expect(vatDueFor({ kind: "year", year: 2026 }).queryKey).toBeNull();
    expect(vatPeriodKindOf("quarter")).toBe("quarter");
    expect(vatPeriodKindOf("whatever")).toBe("month");
    expect(vatPeriodKindOf(null)).toBe("month");
  });

  it("finds the period a month closes", () => {
    expect(vatPeriodEndingIn("2026-08", "month")).toEqual({ kind: "month", year: 2026, month: 8 });
    expect(vatPeriodEndingIn("2026-08", "quarter")).toBeNull();
    expect(vatPeriodEndingIn("2026-09", "quarter")).toEqual({ kind: "quarter", year: 2026, quarter: 3 });
    expect(vatPeriodEndingIn("2026-11", "year")).toBeNull();
    expect(vatPeriodEndingIn("2026-12", "year")).toEqual({ kind: "year", year: 2026 });
  });
});

describe("what the VAT figure does not contain yet (TF-11)", () => {
  it("says how many pending receipts may change it", () => {
    expect(vatPendingNote(august)).toBeNull();
    expect(vatPendingNote({ ...august, pendingReceiptCount: 1 })).toBe("1 kuitti odottaa hyväksyntää. Se voi muuttaa ALV:tä.");
    expect(vatPendingNote({ ...august, pendingReceiptCount: 3 })).toBe("3 kuittia odottaa hyväksyntää. Ne voivat muuttaa ALV:tä.");
  });

  it("notices a figure that moved after filing", () => {
    const filed = { filedAt: "x", paidAt: null, filedAmount: 159.38 };
    expect(vatChangedSinceFiling({ ...august, filing: filed })).toBe(false);
    expect(vatChangedSinceFiling({ ...august, amount: 170, filing: filed })).toBe(true);
    expect(vatChangedSinceFiling({ ...august, isRefund: true, amount: 159.38, filing: filed })).toBe(true);
  });
});
