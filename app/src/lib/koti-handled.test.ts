import { describe, expect, it } from "vitest";
import { handledDetail, handledHref, handledTitle, summariseHandled } from "./koti-handled";
import { monthEvents } from "./koti-month";

describe("Hoidettu automaattisesti", () => {
  it("sums the parts and sorts the biggest first", () => {
    const handled = summariseHandled({ emailReceipts: 12, referencePayments: 2, recurringInvoices: 0 });
    expect(handled.count).toBe(14);
    expect(handled.parts.map((part) => part.kind)).toEqual(["email_receipt", "reference_payment"]);
    expect(handledTitle(handled.count)).toBe("14 tapahtumaa tällä viikolla");
    expect(handledDetail(handled.parts)).toBe("12 kuittia sähköpostista ja 2 maksua kohdistettu viitenumerolla");
  });

  it("is empty (no card) when nothing happened, and ignores bad numbers", () => {
    expect(summariseHandled({ emailReceipts: 0, referencePayments: 0, recurringInvoices: 0 })).toEqual({ count: 0, parts: [] });
    expect(summariseHandled({ emailReceipts: -3, referencePayments: Number.NaN, recurringInvoices: 0 }).count).toBe(0);
  });

  it("speaks singular and joins three parts", () => {
    const handled = summariseHandled({ emailReceipts: 1, referencePayments: 1, recurringInvoices: 4 });
    expect(handled.count).toBe(6);
    expect(handledTitle(1)).toBe("1 tapahtuma tällä viikolla");
    expect(handledDetail(handled.parts)).toBe("4 toistuvaa laskua luotu, 1 kuitti sähköpostista ja 1 maksu kohdistettu viitenumerolla");
    expect(handledDetail([])).toBe("");
  });

  it("opens the list that holds the biggest part", () => {
    expect(handledHref(summariseHandled({ emailReceipts: 5, referencePayments: 1, recurringInvoices: 0 }).parts)).toBe("/kuitit");
    expect(handledHref(summariseHandled({ emailReceipts: 0, referencePayments: 3, recurringInvoices: 1 }).parts)).toBe("/pankki/tapahtumat");
    expect(handledHref(summariseHandled({ emailReceipts: 0, referencePayments: 0, recurringInvoices: 2 }).parts)).toBe("/toistuvat");
  });
});

describe("the month's events", () => {
  it("counts bank rows and receipts together", () => {
    expect(monthEvents({ matchable: 30, matched: 28 }, { approved: 8, pending: 3 })).toEqual({ done: 36, total: 41 });
  });
  it("has no total for an empty month, so no bar", () => {
    expect(monthEvents({ matchable: 0, matched: 0 }, { approved: 0, pending: 0 }).total).toBe(0);
  });
});
