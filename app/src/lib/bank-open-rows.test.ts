import { describe, expect, it } from "vitest";
import { openBankRowsWhere } from "./bank-open-rows";

describe("the open bank rows count", () => {
  it("counts the rows bank-feed's needsAction marks, in the database", () => {
    // rowState: transfers and salaries need nothing; a row that settled a sales or purchase
    // invoice is done; confirmed and ignored rows are done; everything else needs the owner.
    expect(openBankRowsWhere("u1")).toEqual({
      statement: { userId: "u1" },
      type: { notIn: ["oma_siirto", "palkka"] },
      invoicePayment: { is: null },
      purchasePayment: { is: null },
      matchStatus: { notIn: ["confirmed", "ignored"] },
    });
  });
});
