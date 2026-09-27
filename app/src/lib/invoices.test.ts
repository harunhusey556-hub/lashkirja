import { describe, expect, it } from "vitest";
import {
  agingBucket,
  addDaysUtc,
  buildAging,
  buildAgingReport,
  canTransition,
  openPosition,
  computeInvoiceTotals,
  daysOverdue,
  displayStatus,
  dueDateFor,
  InvoiceValidationError,
  isSupportedVatRate,
  lineNet,
  roundHalfAwayFromZero,
  vatForNet,
  type InvoiceLineInput,
} from "./invoices";

const line = (
  quantityMilli: number,
  unitPriceCents: number,
  vatRatePermille = 255
): InvoiceLineInput => ({ quantityMilli, unitPriceCents, vatRatePermille });

describe("rounding", () => {
  it("rounds half away from zero in both directions", () => {
    expect(roundHalfAwayFromZero(0.5)).toBe(1);
    expect(roundHalfAwayFromZero(-0.5)).toBe(-1);
    expect(roundHalfAwayFromZero(1.4)).toBe(1);
    expect(roundHalfAwayFromZero(-1.4)).toBe(-1);
    expect(roundHalfAwayFromZero(2.5)).toBe(3);
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
    expect(roundHalfAwayFromZero(0)).toBe(0);
  });
});

describe("vatForNet", () => {
  it("computes Finnish rates on an exact net", () => {
    expect(vatForNet(10_000, 255)).toBe(2_550);
    expect(vatForNet(10_000, 140)).toBe(1_400);
    expect(vatForNet(10_000, 100)).toBe(1_000);
    expect(vatForNet(10_000, 0)).toBe(0);
  });

  it("rounds to whole cents", () => {
    // 45,00 € at 25,5 % is 11,475 € -> 11,48 €
    expect(vatForNet(4_500, 255)).toBe(1_148);
    // 5,00 € at 13,5 % is 0,675 € -> 0,68 €
    expect(vatForNet(500, 135)).toBe(68);
  });

  it("handles credit (negative) amounts symmetrically", () => {
    expect(vatForNet(-4_500, 255)).toBe(-1_148);
  });
});

describe("lineNet", () => {
  it("multiplies fractional quantities exactly", () => {
    expect(lineNet(line(1_000, 5_000))).toBe(5_000);
    expect(lineNet(line(2_500, 4_000))).toBe(10_000); // 2,5 x 40,00
    expect(lineNet(line(333, 10_000))).toBe(3_330); // 0,333 x 100,00
  });

  it("rounds the product, not the inputs", () => {
    // 0,333 x 3,33 € = 1,10889 € -> 1,11 €
    expect(lineNet(line(333, 333))).toBe(111);
  });

  it("supports negative unit prices for discount lines", () => {
    expect(lineNet(line(1_000, -2_000))).toBe(-2_000);
  });
});

describe("computeInvoiceTotals", () => {
  it("computes a single-rate invoice", () => {
    const totals = computeInvoiceTotals([line(2_000, 4_500), line(1_000, 1_000)]);
    expect(totals.netCents).toBe(10_000);
    expect(totals.vatCents).toBe(2_550);
    expect(totals.grossCents).toBe(12_550);
    expect(totals.breakdown).toEqual([
      { ratePermille: 255, netCents: 10_000, vatCents: 2_550, grossCents: 12_550 },
    ]);
  });

  it("groups several VAT rates, highest first", () => {
    const totals = computeInvoiceTotals([
      line(1_000, 10_000, 255),
      line(1_000, 5_000, 140),
      line(1_000, 2_000, 0),
    ]);
    expect(totals.breakdown.map((row) => row.ratePermille)).toEqual([255, 140, 0]);
    expect(totals.netCents).toBe(17_000);
    expect(totals.vatCents).toBe(2_550 + 700);
    expect(totals.grossCents).toBe(20_250);
  });

  it("aggregates per rate before rounding, so many small lines cannot drift", () => {
    // Each 0,03 € line alone would round VAT to 0,01 €; ten of them must not
    // become 0,10 € when the correct answer on 0,30 € is 0,08 €.
    const lines = Array.from({ length: 10 }, () => line(1_000, 3, 255));
    const totals = computeInvoiceTotals(lines);
    expect(totals.netCents).toBe(30);
    expect(totals.vatCents).toBe(8);
    expect(totals.vatCents).not.toBe(10 * vatForNet(3, 255));
  });

  it("keeps a discount line inside its own rate group", () => {
    const totals = computeInvoiceTotals([line(1_000, 10_000, 255), line(1_000, -1_000, 255)]);
    expect(totals.netCents).toBe(9_000);
    expect(totals.vatCents).toBe(2_295);
    expect(totals.breakdown).toHaveLength(1);
  });

  it("stays exact across a large invoice", () => {
    const lines = Array.from({ length: 500 }, (_, index) =>
      line(1_000, 100 + index, index % 2 === 0 ? 255 : 140)
    );
    const totals = computeInvoiceTotals(lines);
    const sumNet = totals.lines.reduce((sum, l) => sum + l.netCents, 0);
    expect(totals.netCents).toBe(sumNet);
    expect(Number.isSafeInteger(totals.grossCents)).toBe(true);
    expect(totals.grossCents).toBe(totals.netCents + totals.vatCents);
  });

  it("rejects an empty invoice", () => {
    expect(() => computeInvoiceTotals([])).toThrow(InvoiceValidationError);
  });

  it("rejects zero quantity, fractional cents and unknown rates", () => {
    expect(() => computeInvoiceTotals([line(0, 1_000)])).toThrow(InvoiceValidationError);
    expect(() => computeInvoiceTotals([line(1_000.5, 1_000)])).toThrow(InvoiceValidationError);
    expect(() => computeInvoiceTotals([line(1_000, 10.5)])).toThrow(InvoiceValidationError);
    expect(() => computeInvoiceTotals([line(1_000, 1_000, 240)])).toThrow(InvoiceValidationError);
  });

  it("knows which rates are supported", () => {
    expect(isSupportedVatRate(255)).toBe(true);
    expect(isSupportedVatRate(140)).toBe(true);
    expect(isSupportedVatRate(0)).toBe(true);
    expect(isSupportedVatRate(240)).toBe(false);
    expect(isSupportedVatRate(25.5)).toBe(false);
  });
});

describe("due dates", () => {
  it("adds the payment term in whole UTC days", () => {
    expect(dueDateFor(new Date("2026-01-01T00:00:00Z"), 14).toISOString()).toBe(
      "2026-01-15T00:00:00.000Z"
    );
  });

  it("crosses month and year boundaries", () => {
    expect(dueDateFor(new Date("2026-12-20T00:00:00Z"), 30).toISOString().slice(0, 10)).toBe(
      "2027-01-19"
    );
    // 2028 is a leap year: 14 days from 20 Feb lands on 5 March.
    expect(dueDateFor(new Date("2028-02-20T00:00:00Z"), 14).toISOString().slice(0, 10)).toBe(
      "2028-03-05"
    );
  });

  it("allows same-day terms and rejects impossible ones", () => {
    expect(dueDateFor(new Date("2026-01-01T00:00:00Z"), 0).toISOString().slice(0, 10)).toBe(
      "2026-01-01"
    );
    expect(() => dueDateFor(new Date("2026-01-01T00:00:00Z"), -1)).toThrow(InvoiceValidationError);
    expect(() => dueDateFor(new Date("2026-01-01T00:00:00Z"), 400)).toThrow(InvoiceValidationError);
    expect(() => dueDateFor(new Date("2026-01-01T00:00:00Z"), 1.5)).toThrow(InvoiceValidationError);
  });

  it("does not mutate the input date", () => {
    const issue = new Date("2026-01-01T00:00:00Z");
    addDaysUtc(issue, 10);
    expect(issue.toISOString()).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("displayStatus", () => {
  const due = "2026-03-10T00:00:00.000Z";

  it("keeps a sent invoice on time until the due day ends", () => {
    expect(displayStatus({ status: "sent", dueDate: due }, new Date("2026-03-10T23:59:59Z"))).toBe(
      "sent"
    );
  });

  it("turns overdue the following day", () => {
    expect(displayStatus({ status: "sent", dueDate: due }, new Date("2026-03-11T00:00:01Z"))).toBe(
      "overdue"
    );
  });

  it("never marks a draft, paid or credited invoice overdue", () => {
    const late = new Date("2027-01-01T00:00:00Z");
    expect(displayStatus({ status: "draft", dueDate: due }, late)).toBe("draft");
    expect(displayStatus({ status: "paid", dueDate: due }, late)).toBe("paid");
    expect(displayStatus({ status: "credited", dueDate: due }, late)).toBe("credited");
  });
});

describe("daysOverdue and aging buckets", () => {
  const due = "2026-03-10T00:00:00.000Z";

  it("counts whole days after the due date", () => {
    expect(daysOverdue(due, new Date("2026-03-10T12:00:00Z"))).toBe(0);
    expect(daysOverdue(due, new Date("2026-03-11T00:00:00Z"))).toBe(1);
    expect(daysOverdue(due, new Date("2026-04-09T00:00:00Z"))).toBe(30);
    expect(daysOverdue(due, new Date("2026-01-01T00:00:00Z"))).toBe(0);
  });

  it("maps days to buckets at the exact boundaries", () => {
    expect(agingBucket(due, new Date("2026-03-10T00:00:00Z"))).toBe("not_due");
    expect(agingBucket(due, new Date("2026-03-11T00:00:00Z"))).toBe("1-30");
    expect(agingBucket(due, new Date("2026-04-09T00:00:00Z"))).toBe("1-30");
    expect(agingBucket(due, new Date("2026-04-10T00:00:00Z"))).toBe("31-60");
    expect(agingBucket(due, new Date("2026-05-09T00:00:00Z"))).toBe("31-60");
    expect(agingBucket(due, new Date("2026-05-10T00:00:00Z"))).toBe("61-90");
    expect(agingBucket(due, new Date("2026-06-08T00:00:00Z"))).toBe("61-90");
    expect(agingBucket(due, new Date("2026-06-09T00:00:00Z"))).toBe("90+");
  });
});

describe("buildAgingReport", () => {
  const now = new Date("2026-06-01T00:00:00Z");

  it("keeps a paid flag without money or a reason in the aging", () => {
    const report = buildAgingReport(
      [{ status: "paid", dueDate: "2026-05-01", grossCents: 8_000 }],
      now
    );
    expect(report.totalOpenCents).toBe(8_000);
    expect(report.buckets["31-60"].count).toBe(1);
  });

  it("sums only outstanding sent invoices", () => {
    const report = buildAgingReport(
      [
        { status: "sent", dueDate: "2026-07-01", grossCents: 10_000 }, // not due
        { status: "sent", dueDate: "2026-05-20", grossCents: 20_000 }, // 12 days
        { status: "sent", dueDate: "2026-04-01", grossCents: 30_000 }, // 61 days
        { status: "draft", dueDate: "2026-01-01", grossCents: 99_000 },
        { status: "paid", dueDate: "2026-01-01", grossCents: 99_000, paidCents: 99_000 },
        { status: "paid", dueDate: "2026-01-01", grossCents: 50_000, closedReason: "luottotappio" },
        { status: "credited", dueDate: "2026-01-01", grossCents: 99_000 },
      ],
      now
    );

    expect(report.buckets.not_due).toEqual({ count: 1, openCents: 10_000 });
    expect(report.buckets["1-30"]).toEqual({ count: 1, openCents: 20_000 });
    expect(report.buckets["61-90"]).toEqual({ count: 1, openCents: 30_000 });
    expect(report.totalOpenCents).toBe(60_000);
    expect(report.overdueCents).toBe(50_000);
    expect(report.overdueCount).toBe(2);
  });

  it("subtracts partial payments and drops fully-settled rows", () => {
    const report = buildAgingReport(
      [
        { status: "sent", dueDate: "2026-05-01", grossCents: 10_000, paidCents: 4_000 },
        { status: "sent", dueDate: "2026-05-01", grossCents: 10_000, paidCents: 10_000 },
        { status: "sent", dueDate: "2026-05-01", grossCents: 10_000, paidCents: 12_000 },
      ],
      now
    );
    expect(report.totalOpenCents).toBe(6_000);
    // 1 May is 31 days before 1 June, so the row lands in the second bucket.
    expect(report.buckets["31-60"].count).toBe(1);
  });

  it("returns zeroed buckets for no invoices", () => {
    const report = buildAgingReport([], now);
    expect(report.totalOpenCents).toBe(0);
    expect(report.overdueCount).toBe(0);
    expect(Object.keys(report.buckets)).toEqual(["not_due", "1-30", "31-60", "61-90", "90+"]);
  });
});

describe("openPosition", () => {
  it("keeps an unpaid sent invoice collectible", () => {
    expect(openPosition({ status: "sent", grossCents: 10_000, paidCents: 4_000 })).toEqual({
      openCents: 6_000,
      collectible: true,
      settled: false,
    });
  });

  it("settles a covered invoice and keeps an overpayment visible", () => {
    expect(openPosition({ status: "paid", grossCents: 10_000, paidCents: 10_000 }).collectible).toBe(
      false
    );
    expect(openPosition({ status: "sent", grossCents: 10_000, paidCents: 12_000 })).toMatchObject({
      openCents: -2_000,
      collectible: false,
      settled: true,
    });
  });

  it("treats an explicit close as settled with a zero open balance", () => {
    expect(
      openPosition({
        status: "paid",
        grossCents: 10_000,
        paidCents: 0,
        closedReason: "luottotappio",
      })
    ).toEqual({ openCents: 0, collectible: false, settled: true });
  });

  it("does not let a bare paid flag hide an unpaid invoice", () => {
    const position = openPosition({ status: "paid", grossCents: 10_000, paidCents: 0 });
    expect(position).toEqual({ openCents: 10_000, collectible: true, settled: false });
  });

  it("drops drafts, credits and cancellations from collections", () => {
    expect(openPosition({ status: "draft", grossCents: 5_000 }).collectible).toBe(false);
    expect(openPosition({ status: "credited", grossCents: 5_000 })).toMatchObject({
      openCents: 0,
      collectible: false,
      settled: true,
    });
    expect(openPosition({ status: "cancelled", grossCents: 5_000, paidCents: 1_000 })).toMatchObject({
      openCents: 0,
      collectible: false,
    });
  });
});

describe("canTransition", () => {
  it("allows the normal lifecycle", () => {
    expect(canTransition("draft", "sent")).toBe(true);
    expect(canTransition("sent", "paid")).toBe(true);
    expect(canTransition("sent", "draft")).toBe(true);
    expect(canTransition("paid", "sent")).toBe(true);
  });

  it("treats a no-op as allowed", () => {
    expect(canTransition("paid", "paid")).toBe(true);
  });

  it("blocks jumps that would skip sending", () => {
    expect(canTransition("draft", "paid")).toBe(false);
  });

  it("makes crediting final", () => {
    expect(canTransition("credited", "sent")).toBe(false);
    expect(canTransition("credited", "draft")).toBe(false);
    expect(canTransition("credited", "paid")).toBe(false);
  });
});

describe("buildAging", () => {
  const now = new Date("2026-06-01T00:00:00Z");

  it("ages any due-dated open amount, receivable or payable", () => {
    const report = buildAging(
      [
        { dueDate: "2026-07-01", openCents: 10_000 },
        { dueDate: "2026-05-20", openCents: 20_000 },
        { dueDate: "2026-01-01", openCents: 30_000 },
      ],
      now
    );
    expect(report.buckets.not_due.openCents).toBe(10_000);
    expect(report.buckets["1-30"].openCents).toBe(20_000);
    expect(report.buckets["90+"].openCents).toBe(30_000);
    expect(report.totalOpenCents).toBe(60_000);
    expect(report.overdueCount).toBe(2);
  });

  it("ignores settled and negative balances", () => {
    const report = buildAging(
      [
        { dueDate: "2026-05-01", openCents: 0 },
        { dueDate: "2026-05-01", openCents: -500 },
      ],
      now
    );
    expect(report.totalOpenCents).toBe(0);
    expect(report.buckets["31-60"].count).toBe(0);
  });

  it("agrees with buildAgingReport for the receivable case", () => {
    const invoices = [
      { status: "sent" as const, dueDate: "2026-05-01", grossCents: 10_000, paidCents: 4_000 },
      { status: "draft" as const, dueDate: "2026-05-01", grossCents: 99_000 },
    ];
    const viaReport = buildAgingReport(invoices, now);
    const viaGeneric = buildAging([{ dueDate: "2026-05-01", openCents: 6_000 }], now);
    expect(viaReport).toEqual(viaGeneric);
  });
});
