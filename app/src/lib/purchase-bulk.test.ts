import { describe, expect, it } from "vitest";
import { payablePurchases, purchaseBulkLabels, purchaseBulkOutcome, purchaseBulkTitle, type BulkPurchase } from "./purchase-bulk";

const inv = (id: string, over: Partial<BulkPurchase> = {}): BulkPurchase => ({
  id,
  status: "open",
  open: 100,
  ...over,
});

describe("payablePurchases", () => {
  it("keeps open invoices with something to pay and leaves paid, cancelled, credited and credit notes", () => {
    const picked = payablePurchases([
      inv("open"),
      inv("paid", { status: "paid", open: 0 }),
      inv("cancelled", { status: "cancelled" }),
      inv("credited", { status: "credited", open: 0 }),
      inv("note", { isCreditNote: true, open: -50 }),
      inv("zero", { open: 0 }),
    ]);
    expect(picked.map((invoice) => invoice.id)).toEqual(["open"]);
  });
});

describe("purchase bulk copy", () => {
  it("names the count", () => {
    expect(purchaseBulkLabels.pay(3)).toBe("Merkitse maksetuiksi (3)");
    expect(purchaseBulkLabels.remove(2)).toBe("Poista valitut (2)");
    expect(purchaseBulkTitle("pay", 1)).toBe("Merkitäänkö 1 ostolasku maksetuksi?");
    expect(purchaseBulkTitle("remove", 5)).toBe("Poistetaanko 5 ostolaskua?");
  });

  it("reports partial failures", () => {
    expect(purchaseBulkOutcome("pay", 3, 0)).toBe("Merkittiin maksetuiksi 3.");
    expect(purchaseBulkOutcome("remove", 2, 1)).toBe("Poistettiin 2, epäonnistui 1.");
    expect(purchaseBulkOutcome("remove", 0, 2)).toContain("Mikään ei onnistunut");
  });
});
