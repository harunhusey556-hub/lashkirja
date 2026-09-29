import { describe, expect, it } from "vitest";
import { approvalGapText, approvalGaps, serverApprovalBlock } from "./receipt-approval";

describe("receipt approval rule (FP-6)", () => {
  it("a complete receipt has no gaps and the server allows it", () => {
    expect(approvalGaps({ totalAmountCents: 1250, vendor: "K-Market" })).toEqual([]);
    expect(serverApprovalBlock({ totalAmountCents: 1250, vendor: "K-Market" })).toBeNull();
    expect(approvalGaps({ totalAmount: 12.5, vendor: "K-Market" })).toEqual([]);
  });

  it("a zero amount is an amount, not a gap", () => {
    expect(approvalGaps({ totalAmountCents: 0, vendor: "K-Market" })).toEqual([]);
  });

  it("no amount blocks on the server and in the app", () => {
    expect(approvalGaps({ totalAmountCents: null, vendor: "K-Market" })).toEqual(["amount"]);
    expect(serverApprovalBlock({ totalAmountCents: null, vendor: "K-Market" })).toMatch(/summa/);
    expect(serverApprovalBlock({ totalAmount: null })).toMatch(/summa/);
  });

  it("a missing or blank vendor only asks the user to complete it", () => {
    expect(approvalGaps({ totalAmountCents: 100, vendor: "  " })).toEqual(["vendor"]);
    expect(serverApprovalBlock({ totalAmountCents: 100, vendor: null })).toBeNull();
  });

  it("names what is missing", () => {
    expect(approvalGapText(["amount", "vendor"])).toBe("Lisää summa ja myyjä");
    expect(approvalGapText(["amount"])).toBe("Lisää summa");
    expect(approvalGapText(["vendor"])).toBe("Lisää myyjä");
  });
});
