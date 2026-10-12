import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./db", () => ({ prisma: {} }));

import type { ExtractedReceipt } from "./ai";
import { formatDate } from "./format";
import { receiptFieldsFromExtraction, unreadableReceiptFields } from "./receipt-staging";
import { helsinkiCalendarDate, helsinkiDayUtc, isoDateToUtc } from "./validation";

/** The stored receipt date as ISO; the field's type also admits a string. */
function stored(value: string | Date | null | undefined): string | undefined {
  return value == null ? undefined : new Date(value).toISOString();
}

function extraction(date: string | null): ExtractedReceipt {
  return {
    vendor: "K-Market",
    date,
    totalAmount: 12.5,
    vatDetails: [],
    category: null,
    notes: null,
    type: "meno",
    reference: null,
    invoiceNumber: null,
    source: "ocr",
    provenance: "local-ocr",
    confidence: 0.9,
  };
}

// A receipt date is a calendar date: the day the owner sees in Helsinki, stored as that day's
// UTC midnight. The server's own zone must not move it, so every case runs ahead of and behind UTC.
describe.each(["Europe/Helsinki", "America/Los_Angeles", "UTC"])("receipt calendar dates with TZ=%s", (zone) => {
  const previous = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = zone;
  });
  afterAll(() => {
    process.env.TZ = previous;
  });

  it("runs in the zone it names", () => {
    const offset = new Date("2026-10-12T12:00:00Z").getTimezoneOffset();
    expect(offset).toBe({ "Europe/Helsinki": -180, "America/Los_Angeles": 420, UTC: 0 }[zone]);
  });

  it("names the Helsinki day around its midnight", () => {
    expect(helsinkiCalendarDate(new Date("2026-10-12T20:30:00Z"))).toBe("2026-10-12"); // 23.30
    expect(helsinkiCalendarDate(new Date("2026-10-12T21:30:00Z"))).toBe("2026-10-13"); // 00.30
    expect(helsinkiCalendarDate(new Date("2026-10-12T22:30:00Z"))).toBe("2026-10-13"); // 01.30
  });

  it("stores a capture without a read date on the Helsinki day it was taken, not the instant", () => {
    // 01.30 in Helsinki on 13.10 is still 12.10 in UTC (the iOS CI runner's clock).
    const late = receiptFieldsFromExtraction(extraction(null), new Date("2026-10-12T22:30:00Z"));
    expect(stored(late.date)).toBe("2026-10-13T00:00:00.000Z");
    expect(formatDate(stored(late.date))).toBe("13.10.2026");

    const evening = receiptFieldsFromExtraction(extraction(null), new Date("2026-10-12T20:30:00Z"));
    expect(stored(evening.date)).toBe("2026-10-12T00:00:00.000Z");

    const unread = unreadableReceiptFields(new Date("2026-10-12T22:30:00Z"));
    expect(stored(unread.date)).toBe("2026-10-13T00:00:00.000Z");
  });

  it("puts a capture taken after midnight on 1.11 in November's VAT month", () => {
    const fields = receiptFieldsFromExtraction(extraction(null), new Date("2026-10-31T22:30:00Z"));
    expect(stored(fields.date)?.slice(0, 7)).toBe("2026-11");
  });

  it("keeps a read date exactly as the calendar day it names", () => {
    const fields = receiptFieldsFromExtraction(extraction("2026-10-12"), new Date("2026-10-13T22:30:00Z"));
    expect(stored(fields.date)).toBe("2026-10-12T00:00:00.000Z");
  });

  it("round-trips a saved day to the same displayed day", () => {
    for (const day of ["2026-10-12", "2026-10-13", "2026-10-31", "2026-11-01", "2026-03-29"]) {
      const saved = isoDateToUtc(day);
      expect(saved.toISOString().slice(0, 10)).toBe(day);
      const [y, m, d] = day.split("-").map(Number);
      expect(formatDate(saved.toISOString())).toBe(`${d}.${m}.${y}`);
    }
  });

  it("maps an instant to the UTC midnight of its Helsinki day", () => {
    expect(helsinkiDayUtc(new Date("2026-10-12T21:00:00Z")).toISOString()).toBe("2026-10-13T00:00:00.000Z");
    expect(helsinkiDayUtc(new Date("2026-10-12T20:59:59Z")).toISOString()).toBe("2026-10-12T00:00:00.000Z");
  });
});
