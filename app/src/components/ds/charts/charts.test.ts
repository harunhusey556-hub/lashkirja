import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/link", async () => {
  const react = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
      react.createElement("a", { href, ...rest }, children as never),
  };
});

import { BarChart, HBarList, Sparkline, SegmentedProgress, StackedBar } from "./index";
import { barChartSummary, formatAxisEur, monthSummary, rankedSummary } from "./text";
import { formatEur } from "@/lib/format";

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);

const months = Array.from({ length: 12 }, (_, i) => ({
  key: `2025-${String(i + 1).padStart(2, "0")}`,
  label: ["Tammi", "Helmi", "Maalis", "Huhti", "Touko", "Kesä", "Heinä", "Elo", "Syys", "Loka", "Marras", "Joulu"][i],
  title: ["Tammikuu", "Helmikuu", "Maaliskuu", "Huhtikuu", "Toukokuu", "Kesäkuu", "Heinäkuu", "Elokuu", "Syyskuu", "Lokakuu", "Marraskuu", "Joulukuu"][i],
  income: 1000 + i * 100,
  expense: 400 + i * 20,
}));

describe("chart text", () => {
  it("formats axis labels in whole fi-FI euros", () => {
    expect(formatAxisEur(1500)).toBe("1 500 €");
    expect(formatAxisEur(0)).toBe("0 €");
    expect(formatAxisEur(Number.NaN)).toBe("");
  });

  it("writes the sentence above the bars", () => {
    expect(monthSummary({ label: "Syyskuu", income: 1200, expense: 340.5 })).toBe(
      `Syyskuu: tulot ${formatEur(1200)}, menot ${formatEur(340.5)}`,
    );
  });

  it("summarises the whole chart and a ranked list in one sentence", () => {
    expect(barChartSummary(months)).toContain("12 kuukautta");
    expect(barChartSummary(months.slice(0, 1))).toContain("1 kuukausi.");
    expect(rankedSummary([{ label: "Tarvikkeet", valueCents: 42000 }, { label: "Vuokra", valueCents: 18000 }], 60000)).toContain(
      "Suurin: Tarvikkeet",
    );
    expect(rankedSummary([], 0)).toBe("");
  });
});

describe("BarChart", () => {
  it("is a group of buttons when selectable, with the figures printed above", () => {
    const out = html(createElement(BarChart, { items: months, selectedKey: "2025-09", onSelect: () => {} }));
    expect(out).toContain('role="group"');
    expect((out.match(/<button/g) ?? []).length).toBe(12);
    expect(out).toContain('aria-pressed="true"');
    expect(out).toContain("Syyskuu");
    expect(out).toContain(formatEur(1800));
  });

  it("is a labelled image with a hidden table when read only", () => {
    const out = html(createElement(BarChart, { items: months.slice(0, 6) }));
    expect(out).toContain('role="img"');
    expect(out).toContain("sr-only");
    expect(out).not.toContain("<button");
    expect((out.match(/<tr>/g) ?? []).length).toBe(7);
  });

  it("draws no chart for empty data, only the calm sentence", () => {
    const zero = months.map((m) => ({ ...m, income: 0, expense: 0 }));
    const out = html(createElement(BarChart, { items: zero, emptyText: "Kuukausiluvut ilmestyvät tähän." }));
    expect(out).toContain("Kuukausiluvut ilmestyvät tähän.");
    expect(out).not.toContain("<button");
    expect(html(createElement(BarChart, { items: [] }))).toBe("");
  });

  it("handles a negative amount without a NaN anywhere", () => {
    const out = html(createElement(BarChart, { items: [...months.slice(0, 5), { ...months[5], income: -300, expense: 100 }] }));
    expect(out).not.toContain("NaN");
    expect(out).toContain("origin-top");
  });
});

describe("HBarList", () => {
  const items = [
    { key: "a", label: "Tarvikkeet", valueCents: 42000, href: "/kuitit?c=a" },
    { key: "b", label: "Vuokra", valueCents: 18000 },
  ];

  it("prints label, amount and share, and links a row that has an href", () => {
    const out = html(createElement(HBarList, { items, totalCents: 60000 }));
    expect(out).toContain("Tarvikkeet");
    expect(out).toContain(formatEur(420));
    expect(out).toContain("70 %");
    expect(out).toContain('href="/kuitit?c=a"');
    expect((out.match(/<a /g) ?? []).length).toBe(1);
  });

  it("collapses a long tail into Muut and never links it", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ key: `k${i}`, label: `Kat ${i}`, valueCents: 1000 * (9 - i), href: `/x${i}` }));
    const out = html(createElement(HBarList, { items: many, totalCents: 45000 }));
    expect(out).toContain("Muut");
    expect((out.match(/data-testid="hbar-row"/g) ?? []).length).toBe(6);
    expect((out.match(/<a /g) ?? []).length).toBe(5);
  });

  it("says one calm sentence instead of an empty list", () => {
    expect(html(createElement(HBarList, { items: [], totalCents: 0, emptyText: "Ei menoja." }))).toContain("Ei menoja.");
    expect(html(createElement(HBarList, { items: [], totalCents: 0 }))).toBe("");
  });
});

describe("StackedBar, SegmentedProgress and Sparkline", () => {
  it("prints amount and name for every non-zero segment", () => {
    const out = html(createElement(StackedBar, {
      segments: [
        { key: "p", label: "maksettu", valueCents: 50000, tone: "success" },
        { key: "o", label: "avoin", valueCents: 20000, tone: "neutral" },
        { key: "l", label: "myöhässä", valueCents: 0, tone: "danger" },
      ],
    }));
    expect(out).toContain("maksettu");
    expect(out).toContain(formatEur(500));
    expect(out).not.toContain("myöhässä");
    expect(out).toContain('role="img"');
  });

  it("draws the month bar with the filled share and nothing for no items", () => {
    const out = html(createElement(SegmentedProgress, { done: 38, total: 41, label: "38 tapahtumaa 41:stä on kunnossa" }));
    expect((out.match(/bg-success/g) ?? []).length).toBe(11);
    expect((out.match(/bg-line/g) ?? []).length).toBe(1);
    expect(out).toContain('aria-label="38 tapahtumaa 41:stä on kunnossa"');
    expect(html(createElement(SegmentedProgress, { done: 0, total: 0, label: "x" }))).toBe("");
  });

  it("draws a sparkline with a last-point marker and an accessible name", () => {
    const out = html(createElement(Sparkline, { points: [10, 12, 9, 15], ariaLabel: "Saldo nousi 5,00 €" }));
    expect(out).toContain('aria-label="Saldo nousi 5,00 €"');
    expect(out).toContain("<path");
    expect(html(createElement(Sparkline, { points: [], ariaLabel: "x" }))).toBe("");
  });
});
