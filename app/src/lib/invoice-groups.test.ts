import { describe, expect, it } from "vitest";
import {
  INVOICE_LIST_LIMIT,
  salesFilterChips,
  salesInvoiceGroups,
  type SalesStatusCounts,
  type StatusedInvoice,
} from "./invoice-groups";

function invoice(displayStatus: StatusedInvoice["displayStatus"]): StatusedInvoice {
  return { displayStatus };
}

const MIXED: StatusedInvoice[] = [
  invoice("overdue"),
  invoice("draft"),
  invoice("sent"),
  invoice("sent"),
  invoice("paid"),
];

const COUNTS: SalesStatusCounts = { overdue: 1, draft: 1, sent: 2, paid: 1, credited: 0 };

describe("INVOICE_LIST_LIMIT", () => {
  it("is the same cap the server applies to a single fetch", () => {
    expect(INVOICE_LIST_LIMIT).toBe(200);
  });
});

describe("salesFilterChips", () => {
  it("always shows Kaikki, Myöhässä, Luonnokset, Avoimet, Maksetut with live counts, in that order", () => {
    expect(salesFilterChips(COUNTS)).toEqual([
      { id: "all", label: "Kaikki", count: 5 },
      { id: "overdue", label: "Myöhässä", count: 1 },
      { id: "draft", label: "Luonnokset", count: 1 },
      { id: "sent", label: "Avoimet", count: 2 },
      { id: "paid", label: "Maksetut", count: 1 },
    ]);
  });

  it("hides Hyvitetyt when no invoice has been credited", () => {
    const chips = salesFilterChips(COUNTS);
    expect(chips.some((chip) => chip.id === "credited")).toBe(false);
  });

  it("shows Hyvitetyt last, with its count, once at least one invoice is credited", () => {
    const withCredit: SalesStatusCounts = { ...COUNTS, credited: 1 };
    const chips = salesFilterChips(withCredit);
    expect(chips.at(-1)).toEqual({ id: "credited", label: "Hyvitetyt", count: 1 });
  });

  it("still shows the always-on chips at zero when there are no invoices", () => {
    const zero: SalesStatusCounts = { overdue: 0, draft: 0, sent: 0, paid: 0, credited: 0 };
    expect(salesFilterChips(zero)).toEqual([
      { id: "all", label: "Kaikki", count: 0 },
      { id: "overdue", label: "Myöhässä", count: 0 },
      { id: "draft", label: "Luonnokset", count: 0 },
      { id: "sent", label: "Avoimet", count: 0 },
      { id: "paid", label: "Maksetut", count: 0 },
    ]);
  });

  it("sums 'Kaikki' from the counts rather than trusting a separate total", () => {
    const withCredit: SalesStatusCounts = { overdue: 3, draft: 2, sent: 4, paid: 5, credited: 6 };
    expect(salesFilterChips(withCredit)[0]).toEqual({ id: "all", label: "Kaikki", count: 20 });
  });
});

describe("salesInvoiceGroups", () => {
  it("groups the 'all' filter by display status in Myöhässä, Luonnokset, Odottaa maksua, Maksetut, Hyvitetyt order", () => {
    const withCredit = [...MIXED, invoice("credited")];
    const groups = salesInvoiceGroups(withCredit, "all");
    expect(groups.map((group) => group.id)).toEqual(["overdue", "draft", "sent", "paid", "credited"]);
    expect(groups.map((group) => group.label)).toEqual([
      "Myöhässä",
      "Luonnokset",
      "Odottaa maksua",
      "Maksetut",
      "Hyvitetyt",
    ]);
    expect(groups.find((group) => group.id === "sent")?.items).toHaveLength(2);
  });

  it("omits empty status groups from the 'all' view", () => {
    const groups = salesInvoiceGroups(MIXED, "all");
    expect(groups.some((group) => group.id === "credited")).toBe(false);
  });

  it("returns only the matching group, labelled 'Odottaa maksua', when the sent filter is active", () => {
    const groups = salesInvoiceGroups(MIXED, "sent");
    expect(groups).toEqual([{ id: "sent", label: "Odottaa maksua", items: [MIXED[2], MIXED[3]] }]);
  });

  it("returns no groups when a specific filter matches nothing", () => {
    expect(salesInvoiceGroups(MIXED, "credited")).toEqual([]);
  });
});
