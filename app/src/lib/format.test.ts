import { describe, expect, it } from "vitest";
import {
  currentMonthKey,
  formatDate,
  formatDayMonth,
  formatEur,
  formatEurSigned,
  formatMonth,
  formatMonthShort,
  parseFinnishNumber,
  parseMoneyInput,
} from "./format";

/** Finnish formatting uses non-breaking spaces; compare on normalised text. */
const plain = (value: string) => value.replace(/ | /g, " ");

describe("formatEur", () => {
  it("formats with two decimals and the euro sign", () => {
    expect(plain(formatEur(1234.5))).toBe("1 234,50 €");
    expect(plain(formatEur(0))).toBe("0,00 €");
    // Intl fi-FI uses the typographic minus (U+2212), not a hyphen.
    expect(plain(formatEur(-12.34))).toBe("\u221212,34 €");
  });

  it("returns a dash for missing or broken values instead of NaN", () => {
    expect(formatEur(null)).toBe("–");
    expect(formatEur(undefined)).toBe("–");
    expect(formatEur(Number.NaN)).toBe("–");
    expect(formatEur(Number.POSITIVE_INFINITY)).toBe("–");
  });
});

describe("formatEurSigned", () => {
  it("always shows the direction of a difference", () => {
    expect(plain(formatEurSigned(50))).toBe("+50,00 €");
    expect(plain(formatEurSigned(-50))).toBe("−50,00 €");
    expect(plain(formatEurSigned(0))).toBe("0,00 €");
    expect(formatEurSigned(null)).toBe("–");
  });
});

describe("month formatting", () => {
  it("renders Finnish month names", () => {
    expect(formatMonth("2026-01")).toBe("tammikuu 2026");
    expect(formatMonth("2026-12")).toBe("joulukuu 2026");
  });

  it("passes malformed input through untouched", () => {
    expect(formatMonth("2026-13")).toBe("2026-13");
    expect(formatMonth("nope")).toBe("nope");
  });

  it("has a compact form", () => {
    expect(formatMonthShort("2026-03")).toBe("03/2026");
    expect(formatMonthShort("nope")).toBe("nope");
  });

  it("derives the current month in UTC", () => {
    expect(currentMonthKey(new Date("2026-08-20T22:30:00.000Z"))).toBe("2026-08");
    expect(currentMonthKey(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-01");
  });
});

describe("formatDate", () => {
  it("formats an ISO date in Finnish order without timezone drift", () => {
    expect(formatDate("2026-03-05T00:00:00.000Z")).toBe("5.3.2026");
    expect(formatDate("2026-01-01")).toBe("1.1.2026");
  });

  it("returns a dash for empty and invalid input", () => {
    expect(formatDate(null)).toBe("–");
    expect(formatDate("")).toBe("–");
    expect(formatDate("not-a-date")).toBe("–");
  });
});

describe("formatDayMonth", () => {
  it("formats a short day.month. without the year, without timezone drift", () => {
    expect(formatDayMonth("2026-10-06T00:00:00.000Z")).toBe("6.10.");
    expect(formatDayMonth("2026-09-12")).toBe("12.9.");
  });

  it("returns a dash for empty and invalid input", () => {
    expect(formatDayMonth(null)).toBe("–");
    expect(formatDayMonth("")).toBe("–");
    expect(formatDayMonth("not-a-date")).toBe("–");
  });
});

describe("parseFinnishNumber", () => {
  it("accepts comma decimals and thousand spaces", () => {
    expect(parseFinnishNumber("1 234,56")).toBe(1234.56);
    expect(parseFinnishNumber("1234.56")).toBe(1234.56);
    expect(parseFinnishNumber("-12,50")).toBe(-12.5);
    expect(parseFinnishNumber("0")).toBe(0);
  });

  it("rejects junk instead of returning NaN or a partial number", () => {
    for (const bad of ["", "  ", "abc", "12,3,4", "1.2.3", "--5"]) {
      expect(parseFinnishNumber(bad), bad).toBeNull();
    }
  });

  it("reads a pasted euro amount the same way as a plain number", () => {
    expect(parseFinnishNumber("12,50")).toBe(12.5);
    expect(parseFinnishNumber("12.50")).toBe(12.5);
    expect(parseFinnishNumber("12,50 €")).toBe(12.5);
    expect(parseFinnishNumber("€12.50")).toBe(12.5);
    expect(parseFinnishNumber("")).toBeNull();
    expect(parseFinnishNumber("-12,50")).toBe(-12.5);
  });
});

describe("parseMoneyInput", () => {
  it("keeps comma, dot and a pasted euro sign on the same scale", () => {
    expect(parseMoneyInput("12,50")).toBe(12.5);
    expect(parseMoneyInput("12.50")).toBe(12.5);
    expect(parseMoneyInput("12,50 €")).toBe(12.5);
    expect(parseMoneyInput("")).toBeNull();
    expect(parseMoneyInput("   ")).toBeNull();
  });

  it("returns a negative amount and refuses a value that is not cents", () => {
    expect(parseMoneyInput("-1,50")).toBe(-1.5);
    expect(parseMoneyInput("12,555")).toBeNull();
    expect(parseMoneyInput("999999999")).toBeNull();
    expect(parseMoneyInput("€")).toBeNull();
  });
});
