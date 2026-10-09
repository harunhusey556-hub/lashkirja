/**
 * Audit 2026-10-09: two open purchase invoices with the same fixed viite (a monthly rent), and a
 * payment larger than the invoice. The last invoice with the viite took every payment, and an
 * overpayment was recorded and marked paid without a word.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { createPurchaseInvoice, matchPurchasePaymentsFromBank } from "@/lib/purchase-invoices";
import { createStatementWithTransactions, createUser, resetDatabase, type TestUser } from "./helpers/factories";

const VIITE = "1232";
let user: TestUser;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
});

const invoice = (month: string, gross: number) =>
  createPurchaseInvoice(user.id, { supplierName: "Vuokra Oy", reference: VIITE, issueDate: `2026-${month}-01`, dueDate: `2026-${month}-05`, gross });

async function rows(list: Array<{ date: string; amountCents: number }>) {
  const statement = await createStatementWithTransactions(user.id, {
    periodMonth: "2026-09",
    transactions: list.map((row) => ({ ...row, counterparty: "Vuokra Oy" })),
  });
  for (const tx of statement.transactions) await prisma.transaction.update({ where: { id: tx.id }, data: { reference: VIITE } });
  return statement.transactions;
}

describe("reference matching of purchase payments", () => {
  it("two invoices with one viite: each payment pays the invoice of its amount", async () => {
    const august = await invoice("08", 800);
    const september = await invoice("09", 850);
    await rows([{ date: "2026-08-05", amountCents: -80_000 }, { date: "2026-09-05", amountCents: -85_000 }]);
    const result = await matchPurchasePaymentsFromBank(user.id);
    expect(result.applied.map((entry) => [entry.invoiceId, entry.amount]).sort()).toEqual(
      [[august.id, 800], [september.id, 850]].sort()
    );
  });

  it("a payment larger than the invoice is not booked against it automatically", async () => {
    const small = await invoice("09", 124);
    await rows([{ date: "2026-09-05", amountCents: -30_000 }]);
    const result = await matchPurchasePaymentsFromBank(user.id);
    expect(result.applied).toEqual([]);
    expect((await prisma.purchaseInvoice.findUniqueOrThrow({ where: { id: small.id } })).status).toBe("open");
  });
});
