import { describe, expect, it } from "vitest";
import { drillFromSearch, invoiceDrillHref, receiptDrillHref, statementDrillHref } from "./report-drill";

describe("report drill links", () => {
  it("round-trips the filters a report amount opens", () => {
    const href = receiptDrillHref({ month: "2026-03", type: "meno", category: "tarvikkeet" });
    expect(href).toBe("/kuitit?month=2026-03&type=meno&category=tarvikkeet");
    expect(drillFromSearch(href.split("?")[1])).toEqual({
      month: "2026-03",
      type: "meno",
      category: "tarvikkeet",
    });
  });

  it("skips an uncategorised label that is not a stored category", () => {
    expect(receiptDrillHref({ month: "2026-03", category: "Luokittelematon" })).toBe("/kuitit?month=2026-03");
    expect(statementDrillHref("2026-03")).toBe("/pankki/tapahtumat?month=2026-03");
    expect(invoiceDrillHref({ month: "2026-03", status: "draft" })).toBe("/laskut?month=2026-03&status=draft");
  });
});
