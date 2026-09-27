import { describe, expect, it } from "vitest";
import { buildProfitLoss } from "./reports";
import { monthBoundsUtc, helsinkiCalendarDate, helsinkiMonthKey, helsinkiQuarterKey } from "./validation";
import { monthKey } from "./bank-balances";
import { statementTargetMonth, fallbackStatementMonth } from "./report-calendar";

describe("report calendar", () => {
  it("keeps a stored booking day in the same month in every report", () => {
    expect(statementTargetMonth("2026-03-31")).toBe("2026-03");
    expect(monthKey("2026-03-31T00:00:00.000Z")).toBe("2026-03");
    const bounds = monthBoundsUtc("2026-03");
    expect(bounds.start.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(bounds.end.toISOString()).toBe("2026-04-01T00:00:00.000Z");
    expect(new Date("2026-03-31T00:00:00.000Z").getTime()).toBeGreaterThanOrEqual(bounds.start.getTime());
    expect(new Date("2026-03-31T00:00:00.000Z").getTime()).toBeLessThan(bounds.end.getTime());

    const profit = buildProfitLoss([
      {
        type: "tulo",
        date: "2026-03-31T00:00:00.000Z",
        totalAmountCents: 1000,
        category: "myynti",
        vatDetails: JSON.stringify([{ rate: 25.5, amount: 2.03 }]),
      },
      {
        type: "tulo",
        date: "2026-04-01T00:00:00.000Z",
        totalAmountCents: 9999,
        category: "myynti",
        vatDetails: null,
      },
    ]);
    expect(profit.months.map((month) => month.month)).toEqual(["2026-03", "2026-04"]);
    expect(profit.months[0].incomeGrossCents).toBe(1000);
  });

  it("uses Helsinki for today, including the spring month boundary and a leap day", () => {
    // 2026-03-29 is the EEST change. 21:00 UTC on the 31st is 00:00 on 1 April in Helsinki.
    const afterMidnight = new Date("2026-03-31T21:00:00.000Z");
    expect(helsinkiCalendarDate(afterMidnight)).toBe("2026-04-01");
    expect(helsinkiMonthKey(afterMidnight)).toBe("2026-04");
    expect(helsinkiQuarterKey(afterMidnight)).toBe("2026-Q2");
    expect(fallbackStatementMonth(afterMidnight)).toBe("2026-04");
    // The stored 31 March booking stays March. Today being April does not move it.
    expect(statementTargetMonth("2026-03-31")).not.toBe(helsinkiMonthKey(afterMidnight));
    expect(statementTargetMonth("2024-02-29")).toBe("2024-02");
    expect(statementTargetMonth("2024-03-01")).toBe("2024-03");
  });
});
