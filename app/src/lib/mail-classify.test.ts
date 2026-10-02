import { describe, expect, it } from "vitest";
import { buildReceiptWhere } from "./receipt-filters";
import { isTooSmallToBeABill, looksLikeBill } from "./mail-classify";

const base = {
  vendor: "Telia",
  date: "2026-09-01",
  totalAmount: 29.9,
  unreadable: false,
  confidence: 0.8,
};

describe("looksLikeBill", () => {
  it("keeps a document with an amount", () => {
    expect(looksLikeBill(base)).toBe(true);
  });

  it("archives a document nothing could be read from", () => {
    expect(looksLikeBill({ ...base, unreadable: true })).toBe(false);
  });

  it("archives a document without an amount", () => {
    expect(looksLikeBill({ ...base, totalAmount: null })).toBe(false);
    expect(looksLikeBill({ ...base, totalAmount: 0 })).toBe(false);
  });

  it("archives a low-confidence read with neither vendor nor date", () => {
    expect(looksLikeBill({ ...base, vendor: null, date: null, confidence: 0.2 })).toBe(false);
  });

  it("keeps a low-confidence read that still names a vendor", () => {
    expect(looksLikeBill({ ...base, confidence: 0.2 })).toBe(true);
  });
});

describe("isTooSmallToBeABill", () => {
  it("skips small images such as logos and tracking pixels", () => {
    expect(isTooSmallToBeABill("image/png", 8_000)).toBe(true);
  });

  it("keeps a photographed receipt", () => {
    expect(isTooSmallToBeABill("image/jpeg", 250_000)).toBe(false);
  });

  it("never skips a PDF by size", () => {
    expect(isTooSmallToBeABill("application/pdf", 3_000)).toBe(false);
  });
});

describe("receipt list source filter", () => {
  it("narrows to receipts read from email", () => {
    expect(buildReceiptWhere("u1", { source: "email_sync" }).source).toBe("email_sync");
  });
});
