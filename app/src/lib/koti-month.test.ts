import { describe, expect, it } from "vitest";
import {
  kotiHeadline,
  kotiMonthHasActivity,
  kotiMonthHref,
  kotiResultBasis,
  kotiResultLabel,
  kotiStatementLine,
  parseKotiMonth,
  type KotiMonthFacts,
} from "./koti-month";

const past: KotiMonthFacts = {
  atCurrent: false,
  blockingCount: 0,
  setupEmpty: false,
  otherOpen: false,
  hasActivity: true,
  hasStatement: true,
};

describe("Koti says what is true about a month (F10, F26)", () => {
  it("never says Kaikki kirjattu for a past month with nothing in it", () => {
    expect(kotiHeadline({ ...past, hasActivity: false, hasStatement: false })).toBe("Ei kirjauksia tässä kuussa");
  });

  it("says Kaikki kirjattu only for a past month that has a tiliote and nothing open", () => {
    expect(kotiHeadline(past)).toBe("Kaikki kirjattu");
    expect(kotiHeadline({ ...past, hasStatement: false })).toBe("Ei avoimia asioita");
  });

  it("counts open things first, and keeps the start checklist for a new account", () => {
    expect(kotiHeadline({ ...past, blockingCount: 2 })).toBe("2 asiaa kesken");
    expect(kotiHeadline({ ...past, atCurrent: true, blockingCount: 1 })).toBe("1 asia ennen kuun loppua");
    expect(kotiHeadline({ ...past, atCurrent: true, setupEmpty: true, hasActivity: false })).toBe("Aloitetaan");
  });

  it("keeps the current month's own words when there is activity", () => {
    expect(kotiHeadline({ ...past, atCurrent: true })).toBe("Kaikki kunnossa");
    expect(kotiHeadline({ ...past, atCurrent: true, otherOpen: true })).toBe("Kirjanpito on ajan tasalla");
    expect(kotiHeadline({ ...past, atCurrent: true, hasActivity: false })).toBe("Ei kirjauksia tässä kuussa");
  });

  it("finds activity in bank rows, receipts or invoices", () => {
    expect(kotiMonthHasActivity({ txCount: 0, receiptCount: 0, invoiceCount: 0 })).toBe(false);
    expect(kotiMonthHasActivity({ txCount: 1, receiptCount: 0 })).toBe(true);
    expect(kotiMonthHasActivity({ txCount: 0, receiptCount: 0, invoiceCount: 2 })).toBe(true);
  });

  it("does not say 'tämän kuun' about a past month, and is silent about an empty one", () => {
    const base = { atCurrent: false, hasActivity: true, hasStatement: false, setupEmpty: false };
    expect(kotiStatementLine(base)).toBe("Tältä kuulta ei ole tiliotetta.");
    expect(kotiStatementLine({ ...base, hasActivity: false })).toBeNull();
    expect(kotiStatementLine({ ...base, atCurrent: true })).toBe("Tämän kuun tiliotetta ei ole vielä.");
    expect(kotiStatementLine({ ...base, hasStatement: true })).toBeNull();
    expect(kotiStatementLine({ ...base, atCurrent: true, setupEmpty: true })).toBeNull();
  });
});

describe("Tulot and Menot name their basis (F11)", () => {
  it("tells a VAT-registered owner that Koti's figures include VAT", () => {
    expect(kotiResultBasis("kuitit", true)).toBe("laskujen ja kuittien mukaan, sis. ALV");
    expect(kotiResultBasis("tiliote", true)).toBe("tiliotteen mukaan, sis. ALV");
    expect(kotiResultBasis("kuitit", false)).toBe("laskujen ja kuittien mukaan");
  });

  it("carries the basis in the card's accessible name", () => {
    expect(kotiResultLabel("Tulot", "81,58 €", true)).toBe("Tulot 81,58 € sis. ALV, avaa");
    expect(kotiResultLabel("Menot", "341,90 €", false)).toBe("Menot 341,90 €, avaa");
  });
});

describe("the month Koti shows survives Back (F25)", () => {
  it("reads a valid past month from the address and falls back to the current one", () => {
    expect(parseKotiMonth("2026-08", "2026-10")).toBe("2026-08");
    expect(parseKotiMonth(null, "2026-10")).toBe("2026-10");
    expect(parseKotiMonth("2026-13", "2026-10")).toBe("2026-10");
    expect(parseKotiMonth("elokuu", "2026-10")).toBe("2026-10");
    expect(parseKotiMonth("2027-01", "2026-10")).toBe("2026-10");
  });

  it("writes the current month as the plain address", () => {
    expect(kotiMonthHref("2026-08", "2026-10")).toBe("/dashboard?month=2026-08");
    expect(kotiMonthHref("2026-10", "2026-10")).toBe("/dashboard");
  });
});
