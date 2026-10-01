import { describe, expect, it } from "vitest";
import { lockedOnlyMessage, runPlanInvoiceCount, runPlanSummary, runResultSummary } from "./runPlan";

const entry = (grossByDate: number[], extra = {}) => ({
  recurringInvoiceId: "r1",
  name: "Kuukausiylläpito",
  customerName: "Asiakas",
  customerEmail: null,
  autoSend: false,
  grossByDate,
  issueDates: grossByDate.map((_, i) => `2026-0${i + 1}-15`),
  ...extra,
});

const norm = (text: string) => text.replace(/[  ]/g, " ");

describe("runPlanSummary", () => {
  it("names the amount of a single run", () => {
    expect(norm(runPlanSummary([entry([50])]))).toContain("Kuukausiylläpito 50,00 €.");
  });

  it("shows what each run will actually bill when the amounts differ (V2)", () => {
    const text = norm(runPlanSummary([entry([114, 113.5, 113.5])]));
    expect(text).toContain("1 × 114,00 € + 2 × 113,50 €");
  });
});

describe("runPlanSummary counts invoices, not schedules (G06)", () => {
  it("an autoSend schedule three months behind announces three mails", () => {
    const text = norm(runPlanSummary([entry([50.2, 50.2, 50.2], { autoSend: true, customerEmail: "a@b.fi" })]));
    expect(text).toContain("3 lähetetään sähköpostilla.");
    expect(text).not.toContain("jää luonnokseksi");
    expect(text).toContain("Lähetettyä laskua ei voi perua");
  });

  it("a manual schedule three months behind announces three drafts and no mail", () => {
    const text = norm(runPlanSummary([entry([62.75, 62.75, 62.75])]));
    expect(text).toContain("3 jää luonnokseksi.");
    expect(text).not.toContain("lähetetään");
    expect(text).not.toContain("Lähetettyä laskua ei voi perua");
  });

  it("a mix adds up per invoice, and an autoSend schedule without an e-mail makes drafts", () => {
    const text = norm(
      runPlanSummary([
        entry([1, 2, 3], { autoSend: true, customerEmail: "a@b.fi" }),
        entry([4, 5], { recurringInvoiceId: "r2", name: "Toinen" }),
        entry([6], { recurringInvoiceId: "r3", name: "Kolmas", autoSend: true, customerEmail: null }),
      ])
    );
    expect(text).toContain("3 lähetetään sähköpostilla.");
    expect(text).toContain("3 jää luonnokseksi.");
    expect(runPlanInvoiceCount([entry([1, 2, 3]), entry([4, 5])])).toBe(5);
  });

  it("keeps the singular for one invoice", () => {
    expect(norm(runPlanSummary([entry([9], { autoSend: true, customerEmail: "a@b.fi" })]))).toContain(
      "1 lähetetään sähköpostilla."
    );
    expect(norm(runPlanSummary([entry([9])]))).toContain("1 jää luonnokseksi.");
  });
});

describe("closed months in the plan (G05)", () => {
  it("names the months held back and where to open them", () => {
    const text = norm(
      runPlanSummary([entry([100], { issueDates: ["2026-09-05"], lockedDates: ["2026-07-05", "2026-08-05"] })])
    );
    expect(text).toContain("Heinäkuu 2026, elokuu 2026 ovat suljettuja kausia");
    expect(text).toContain("Kirjanpito > Suljetut kaudet");
  });

  it("says plainly that nothing can be made when every due date is locked", () => {
    const message = lockedOnlyMessage([entry([], { issueDates: [], lockedDates: ["2026-07-05"] })]);
    expect(message).toContain("Heinäkuu 2026 on suljettu kausi, joten laskuja ei voi luoda.");
  });
});

describe("runResultSummary never reports a plain success over something undone (G05, G07)", () => {
  it("names the months a lock held back, with the way out, in a calm tone", () => {
    const result = runResultSummary({
      generated: [{ sent: false, sendError: null }],
      skipped: [
        { reason: "period_locked", issueDate: "2026-07-05" },
        { reason: "period_locked", issueDate: "2026-08-05" },
      ],
    });
    expect(result.tone).toBe("info");
    expect(norm(result.text)).toContain("1 lasku luotiin.");
    expect(norm(result.text)).toContain("Heinäkuu 2026, elokuu 2026 jäivät luomatta, koska kausi on suljettu.");
    expect(result.text).toContain("Kirjanpito > Suljetut kaudet");
  });

  it("is an error tone when a mail did not leave", () => {
    const result = runResultSummary({
      generated: [
        { sent: false, sendError: "SMTP down" },
        { sent: true, sendError: null },
      ],
      skipped: [],
    });
    expect(result.tone).toBe("error");
    expect(result.text).toContain("2 laskua luotiin.");
    expect(result.text).toContain("1 lähetys epäonnistui");
  });

  it("is a plain success when everything was done", () => {
    expect(runResultSummary({ generated: [{ sent: true, sendError: null }], skipped: [] })).toEqual({
      text: "1 lasku luotiin.",
      tone: "success",
    });
  });

  it("reports earlier unsent invoices that went out now", () => {
    const result = runResultSummary({ generated: [], skipped: [], sendRetries: [{ sent: true }] });
    expect(result.text).toBe("1 aiemmin lähettämättä jäänyt lasku lähetettiin.");
    expect(result.tone).toBe("success");
  });
});
