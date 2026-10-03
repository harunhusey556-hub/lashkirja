import { describe, expect, it } from "vitest";
import {
  MAX_NOTIFICATIONS,
  boundFeed,
  missingReceiptText,
  monthCloseDue,
  monthCloseText,
  overdueInvoiceText,
  receiptReviewText,
  vatDueDays,
  vatDueText,
  type AppNotification,
  type NotificationKind,
} from "./notification-rules";

function many(kind: NotificationKind, count: number): AppNotification[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${kind}:${index}`,
    kind,
    title: "t",
    body: "b",
    href: "/",
    createdAt: "2026-10-01T00:00:00.000Z",
  }));
}

describe("boundFeed", () => {
  it("caps each kind and the whole feed, the urgent kinds first", () => {
    const items = boundFeed({
      missing_receipt: many("missing_receipt", 30),
      overdue_invoice: many("overdue_invoice", 9),
      receipt_review: many("receipt_review", 9),
      bank_sync_failed: many("bank_sync_failed", 1),
      vat_due: many("vat_due", 1),
    });
    expect(items.length).toBe(MAX_NOTIFICATIONS);
    expect(items[0].kind).toBe("bank_sync_failed");
    expect(items[1].kind).toBe("vat_due");
    expect(items.filter((item) => item.kind === "missing_receipt").length).toBeLessThanOrEqual(10);
    expect(items.filter((item) => item.kind === "overdue_invoice").length).toBe(5);
  });
});

describe("VAT due window", () => {
  it("counts the days left, null outside 0–3", () => {
    expect(vatDueDays("2026-10-12", "2026-10-09")).toBe(3);
    expect(vatDueDays("2026-10-12", "2026-10-12")).toBe(0);
    expect(vatDueDays("2026-10-12", "2026-10-08")).toBeNull();
    expect(vatDueDays("2026-10-12", "2026-10-13")).toBeNull();
  });

  it("says when, in plain Finnish", () => {
    expect(vatDueText("Elokuu 2026", "2026-10-12", 2026, 3).body).toBe(
      "Elokuu 2026: ilmoita OmaVerossa viimeistään 12.10."
    );
    expect(vatDueText("Elokuu 2026", "2026-10-12", 2026, 0).body).toBe("Elokuu 2026: ilmoita OmaVerossa tänään.");
    expect(vatDueText("Elokuu 2026", "2026-10-12", 2026, 1).body).toBe("Elokuu 2026: ilmoita OmaVerossa huomenna.");
  });
});

describe("month close", () => {
  it("is due after the 5th for the previous month, when open and not empty", () => {
    expect(monthCloseDue("2026-10-05", { locked: false, hasContent: true })).toBeNull();
    expect(monthCloseDue("2026-10-06", { locked: false, hasContent: true })).toBe("2026-09");
    expect(monthCloseDue("2026-01-10", { locked: false, hasContent: true })).toBe("2025-12");
    expect(monthCloseDue("2026-10-06", { locked: true, hasContent: true })).toBeNull();
    expect(monthCloseDue("2026-10-06", { locked: false, hasContent: false })).toBeNull();
  });

  it("names the month", () => {
    expect(monthCloseText("2026-09").title).toBe("Syyskuu on sulkematta");
  });
});

describe("texts", () => {
  it("missing receipt: the party, the amount without a minus, the day", () => {
    const text = missingReceiptText("K-Market", -24.9, "2026-09-28");
    expect(text.title).toBe("Kuitti puuttuu");
    expect(text.body).toMatch(/^K-Market 24,90\s€, 28\.9\. Kuvaa kuitti\.$/);
  });

  it("overdue invoice: first time and after a reminder", () => {
    expect(overdueInvoiceText({ number: 12, party: "Anna", openEur: 120, daysLate: 1, step: 0 })).toEqual({
      title: "Lasku on myöhässä",
      body: expect.stringMatching(/^Lasku 12, Anna, 120,00\s€: 1 päivä myöhässä\. Lähetä muistutus\.$/),
    });
    expect(overdueInvoiceText({ number: 12, party: "Anna", openEur: 120, daysLate: 30, step: 1 }).title).toBe(
      "Muistutuksen maksuaika on päättynyt"
    );
  });

  it("receipt review", () => {
    expect(receiptReviewText("Elisa Oyj", 39.9).body).toMatch(/^Elisa Oyj 39,90\s€ odottaa tarkistusta\.$/);
    expect(receiptReviewText("Kuitti 1.10.", null).body).toBe("Kuitti 1.10. odottaa tarkistusta.");
  });
});
