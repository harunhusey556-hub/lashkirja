import { describe, expect, it } from "vitest";
import {
  bankMatchBadge,
  invoiceBadge,
  matchingSummaryBadge,
  pendingReceiptCopy,
  purchaseBadge,
  receiptMatchBadge,
} from "./status-badge";

describe("status badges", () => {
  it("colors an invoice from its live display status", () => {
    expect(invoiceBadge("sent")).toEqual({ tone: "accent", label: "Lähetetty" });
    expect(invoiceBadge("overdue").tone).toBe("danger");
    expect(invoiceBadge("paid").tone).toBe("success");
    expect(invoiceBadge("draft").tone).toBe("neutral");
  });

  it("colors a purchase the same way", () => {
    expect(purchaseBadge("overdue").tone).toBe("danger");
    expect(purchaseBadge("paid").tone).toBe("success");
    expect(purchaseBadge("open").tone).toBe("accent");
  });

  it("treats receipt suggestions as a review, including loose candidates", () => {
    expect(receiptMatchBadge("linked").tone).toBe("success");
    expect(receiptMatchBadge("suggested")).toEqual({ tone: "warning", label: "Ehdotus" });
    expect(receiptMatchBadge("none", 2)).toEqual({ tone: "warning", label: "Ehdotuksia" });
    expect(receiptMatchBadge("none", 0).tone).toBe("neutral");
  });

  it("does not paint a bank suggestion as linked", () => {
    expect(bankMatchBadge("meno", "suggested")?.tone).toBe("warning");
    expect(bankMatchBadge("meno", "confirmed")?.tone).toBe("success");
    expect(bankMatchBadge("oma_siirto", "unmatched")).toBeNull();
  });

  it("keeps the home matching count honest", () => {
    expect(matchingSummaryBadge({ matchable: 10, matched: 6, suggested: 1 })).toEqual({
      tone: "warning",
      label: "puuttuu",
      count: 3,
    });
    expect(matchingSummaryBadge({ matchable: 4, matched: 2, suggested: 2 })).toEqual({
      tone: "accent",
      label: "ehdotusta",
      count: 2,
    });
    expect(matchingSummaryBadge({ matchable: 4, matched: 4, suggested: 0 })?.label).toBe("Kaikki ok");
    expect(matchingSummaryBadge({ matchable: 0, matched: 0, suggested: 0 })).toBeNull();
  });

  it("pluralizes the pending-receipt count", () => {
    expect(pendingReceiptCopy(1)).toBe("1 kuitti odottaa tarkistustasi.");
    expect(pendingReceiptCopy(3)).toBe("3 kuittia odottaa tarkistustasi.");
  });
});
