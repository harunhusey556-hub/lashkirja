import { describe, expect, it } from "vitest";
import {
  activeMonths,
  chartMonths,
  defaultSelectedKey,
  expenseRankedItems,
  reportSentence,
  type ChartPeriod,
} from "./report-chart";

const p = (month: string, income: number, expense: number): ChartPeriod => ({
  month,
  incomeNet: income,
  expenseNet: expense,
  profitNet: income - expense,
});
const now = { year: 2026, month: 10 };

describe("chartMonths", () => {
  it("shows the six months ending with the current one in the running year", () => {
    const items = chartMonths([p("2026-08", 100, 20)], 2026, now);
    expect(items.map((i) => i.key)).toEqual(["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
    expect(items[3].income).toBe(100);
    expect(items[0].income).toBe(0);
  });
  it("starts in January early in the year and still has six columns", () => {
    const items = chartMonths([], 2026, { year: 2026, month: 3 });
    expect(items.map((i) => i.key)).toEqual(["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"]);
  });
  it("shows all twelve months of a past year", () => {
    expect(chartMonths([], 2025, now)).toHaveLength(12);
  });
  it("keeps negative and zero months as they are", () => {
    const items = chartMonths([p("2025-02", 0, 50)], 2025, now);
    expect(items[1]).toMatchObject({ income: 0, expense: 50, title: "Helmikuu" });
  });
});

describe("defaultSelectedKey", () => {
  it("picks the latest month with data", () => {
    const items = chartMonths([p("2026-08", 100, 20)], 2026, now);
    expect(defaultSelectedKey(items)).toBe("2026-08");
  });
  it("falls back to the last column", () => {
    expect(defaultSelectedKey(chartMonths([], 2026, now))).toBe("2026-10");
  });
});

describe("activeMonths", () => {
  it("ignores empty months", () => {
    expect(activeMonths([p("2026-01", 0, 0), p("2026-02", 5, 0)])).toHaveLength(1);
  });
});

describe("reportSentence", () => {
  const year = [p("2026-06", 300, 100), p("2026-07", 400, 100), p("2026-08", 900, 200), p("2026-09", 500, 100)];
  it("names the strongest month so far", () => {
    expect(reportSentence(year, 2026, now)).toBe("Elokuu oli tähän asti vuoden vahvin kuukausi.");
  });
  it("uses the present tense when the strongest month is the running one", () => {
    expect(reportSentence([...year, p("2026-10", 2000, 0)], 2026, now)).toBe(
      "Lokakuu on tähän asti vuoden vahvin kuukausi.",
    );
  });
  it("speaks of a finished year without the running-year wording", () => {
    const past = year.map((m) => ({ ...m, month: (m.month as string).replace("2026", "2025") }));
    expect(reportSentence(past, 2025, now)).toBe("Elokuu oli vuoden vahvin kuukausi.");
  });
  it("says so when expenses exceed income", () => {
    expect(reportSentence([p("2026-07", 10, 100), p("2026-08", 20, 100), p("2026-09", 30, 100)], 2026, now)).toBe(
      "Menot ovat tähän asti suuremmat kuin tulot.",
    );
  });
  it("is silent with fewer than three months, on a tie or when nothing was earned", () => {
    expect(reportSentence(year.slice(0, 2), 2026, now)).toBeNull();
    expect(reportSentence([p("2026-07", 100, 0), p("2026-08", 100, 0), p("2026-09", 50, 0)], 2026, now)).toBeNull();
    expect(reportSentence([p("2026-07", 100, 100), p("2026-08", 80, 80), p("2026-09", 50, 50)], 2026, now)).toBeNull();
  });
});

describe("expenseRankedItems", () => {
  it("links categories to the year's receipts and leaves the uncategorised row plain", () => {
    const { items, totalCents } = expenseRankedItems(
      [
        { category: "tarvikkeet", net: 120.5 },
        { category: "Luokittelematon", net: 10 },
        { category: "hyvitys", net: -5 },
      ],
      2026,
    );
    expect(totalCents).toBe(13050);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ label: "Tarvikkeet", valueCents: 12050, href: "/kuitit?month=2026&type=meno&category=tarvikkeet" });
    expect(items[1].href).toBeUndefined();
  });
});
