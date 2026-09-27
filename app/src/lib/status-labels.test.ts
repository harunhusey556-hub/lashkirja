import { describe, expect, it } from "vitest";
import { PURCHASE_STATUS, SALES_STATUS } from "./status-labels";

describe("status labels", () => {
  it("keeps the Finnish sales invoice words the app already shows", () => {
    expect(Object.fromEntries(Object.entries(SALES_STATUS).map(([k, v]) => [k, v.label]))).toEqual({
      draft: "Luonnos", sent: "Lähetetty", overdue: "Myöhässä", paid: "Maksettu", credited: "Hyvitetty",
    });
    expect(SALES_STATUS.overdue.tone).toBe("danger");
    expect(SALES_STATUS.paid.tone).toBe("success");
  });
  it("keeps the purchase invoice words", () => {
    expect(PURCHASE_STATUS.open.label).toBe("Avoin");
    expect(PURCHASE_STATUS.cancelled.label).toBe("Mitätöity");
    expect(PURCHASE_STATUS.overdue.tone).toBe("danger");
  });
});
