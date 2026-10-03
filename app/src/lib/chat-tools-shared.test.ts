import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, eur, fuzzyMatch, pageOf, previousPeriods, resolvePeriod } from "./chat-tools-shared";

const NOW = new Date("2026-10-15T09:00:00.000Z");

describe("chat tool helpers", () => {
  it("writes cents as exact euros", () => {
    expect(eur(123456)).toBe("1234.56");
    expect(eur(5)).toBe("0.05");
    expect(eur(-1999)).toBe("-19.99");
    expect(eur(0)).toBe("0.00");
  });

  it("matches names the way people type them", () => {
    expect(fuzzyMatch("virtaselle", "Virtanen Oy")).toBe(true);
    expect(fuzzyMatch("Mäkiseltä", "Mäkinen Tmi")).toBe(true);
    expect(fuzzyMatch("anna laineelle", "Anna Laine")).toBe(true);
    expect(fuzzyMatch("lumne", "Lumene Tukku")).toBe(true);
    expect(fuzzyMatch("hameenlinna", "Hämeenlinnan Kauneus")).toBe(true);
    expect(fuzzyMatch("korhonen", "Virtanen Oy")).toBe(false);
    expect(fuzzyMatch("neste", "Lumene Tukku")).toBe(false);
  });

  it("reads periods and ranges, and the periods before them", () => {
    expect(resolvePeriod({ period: "2026-Q3" }, NOW)).toMatchObject({ fromMonth: "2026-07", toMonth: "2026-09", months: 3 });
    expect(resolvePeriod({ period: "2026" }, NOW)).toMatchObject({ months: 12 });
    expect(resolvePeriod({ from: "2026-07" }, NOW)).toMatchObject({ key: "2026-07..2026-10" });
    expect(resolvePeriod({}, NOW)).toBeNull();
    expect(resolvePeriod({}, NOW, true)?.key).toBe("2026-10");
    expect(() => resolvePeriod({ period: "syyskuu" }, NOW)).toThrow();
    expect(() => resolvePeriod({ from: "2020-01", to: "2026-01" }, NOW)).toThrow();
    const q3 = resolvePeriod({ period: "2026-Q3" }, NOW)!;
    expect(previousPeriods(q3, 2).map((p) => p.key)).toEqual(["2026-04..2026-06", "2026-01..2026-03"]);
    expect(previousPeriods(resolvePeriod({ period: "2026-01" }, NOW)!, 1)[0].key).toBe("2025-12");
  });

  it("pages with an opaque cursor and refuses a forged one", () => {
    const rows = Array.from({ length: 23 }, (_, i) => i);
    const first = pageOf(rows, undefined, 10);
    expect(first.items).toEqual(rows.slice(0, 10));
    const last = pageOf(rows, pageOf(rows, first.nextCursor, 10).nextCursor, 10);
    expect(last.items).toEqual([20, 21, 22]);
    expect(last.nextCursor).toBeNull();
    expect(decodeCursor(encodeCursor(40))).toBe(40);
    expect(() => decodeCursor("eyJvIjotMX0")).toThrow();
    expect(() => decodeCursor("garbage")).toThrow();
  });
});
