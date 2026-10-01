import { describe, expect, it } from "vitest";
import { paidWithinWindowCents, receivablesSegments } from "./receivables-summary";

const now = new Date("2026-10-01T12:00:00Z");

describe("paidWithinWindowCents", () => {
  it("counts only payments from the last 90 days", () => {
    const sum = paidWithinWindowCents(
      [
        { paidDate: "2026-09-30", amountCents: 10000 },
        { paidDate: "2026-07-10", amountCents: 5000 },
        { paidDate: "2026-06-01", amountCents: 99999 },
      ],
      now
    );
    expect(sum).toBe(15000);
  });
  it("never goes negative and ignores bad dates", () => {
    expect(paidWithinWindowCents([{ paidDate: "2026-09-30", amountCents: -500 }], now)).toBe(0);
    expect(paidWithinWindowCents([{ paidDate: "nonsense", amountCents: 500 }], now)).toBe(0);
    expect(paidWithinWindowCents([], now)).toBe(0);
  });
});

describe("receivablesSegments", () => {
  it("orders paid, waiting, late and takes waiting from the not_due bucket", () => {
    const segments = receivablesSegments({
      buckets: { not_due: { openCents: 700 }, "1-30": { openCents: 300 } },
      overdueCents: 300,
      paidCents: 1200,
    });
    expect(segments.map((s) => [s.key, s.valueCents])).toEqual([
      ["paid", 1200],
      ["sent", 700],
      ["overdue", 300],
    ]);
    expect(segments[0].label).toBe("Maksettu 90 pv");
  });
  it("leaves the paid part out when the figure is unknown", () => {
    const segments = receivablesSegments({ buckets: {}, overdueCents: 0 });
    expect(segments.map((s) => s.key)).toEqual(["sent", "overdue"]);
  });
});
