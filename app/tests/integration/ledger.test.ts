import { beforeEach, describe, expect, it } from "vitest";
import { GET as ledger } from "@/app/api/ledger/route";
import { GET as ledgerExport } from "@/app/api/ledger/export/route";
import { prisma } from "@/lib/db";
import { createReceipt, createStatementWithTransactions, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

/** The derived double-entry books (lib/ledger) read the same documents as the VAT return. */

let user: TestUser;
let cookie: string;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

async function books(year = 2026): Promise<Json> {
  const response = await ledger(buildRequest("GET", `/api/ledger?year=${year}`, undefined, { cookie }));
  expect(response.status).toBe(200);
  return readJson(response);
}

async function salesInvoice(issue: string, netCents: number) {
  const customer = await prisma.customer.create({ data: { userId: user.id, name: "Asiakas Oy" } });
  return prisma.salesInvoice.create({
    data: {
      userId: user.id,
      customerId: customer.id,
      number: Math.floor(Math.random() * 100_000),
      reference: "1234561",
      issueDate: new Date(`${issue}T00:00:00Z`),
      dueDate: new Date(`${issue}T00:00:00Z`),
      status: "sent",
      netCents,
      vatCents: Math.round(netCents * 0.255),
      grossCents: netCents + Math.round(netCents * 0.255),
      lines: { create: [{ description: "Ripsienpidennys", quantityMilli: 1000, unitPriceCents: netCents, vatRatePermille: 255, netCents }] },
    },
  });
}

describe("GET /api/ledger", () => {
  it("posts invoices, payments, receipts and purchase invoices into balanced books", async () => {
    const invoice = await salesInvoice("2026-03-10", 10_000);
    await prisma.invoicePayment.create({
      data: { invoiceId: invoice.id, paidDate: new Date("2026-03-20T00:00:00Z"), amountCents: 12_550, source: "manual" },
    });
    // A receipt paid from the bank, and one with no bank row.
    const paid = await createReceipt(user.id, { date: "2026-03-12", totalAmountCents: 1_255, vatDetails: '[{"rate":25.5,"amount":2.55}]', reviewStatus: "approved", category: "tarvikkeet" });
    const statement = await createStatementWithTransactions(user.id, { periodMonth: "2026-03", transactions: [{ date: "2026-03-12", amountCents: -1_255 }] });
    await prisma.transaction.update({ where: { id: statement.transactions[0].id }, data: { receiptId: paid.id, matchStatus: "confirmed" } });
    await createReceipt(user.id, { date: "2026-03-13", totalAmountCents: 500, vatDetails: null, reviewStatus: "approved", category: null });
    await prisma.purchaseInvoice.create({
      data: {
        userId: user.id, supplierName: "Tukku Oy", issueDate: new Date("2026-03-05T00:00:00Z"), dueDate: new Date("2026-03-19T00:00:00Z"),
        status: "open", grossCents: 12_400, vatCents: 2_519, netCents: 9_881, category: "tarvikkeet",
      },
    });

    const body = await books();
    expect(body.notes.balances).toBe(true);
    const trial = Object.fromEntries(body.trialBalance.map((row: Json) => [row.code, row.balanceCents]));
    expect(Object.values(trial).reduce((a: number, b) => a + (b as number), 0)).toBe(0);
    expect(trial["1700"]).toBe(0); // invoiced and paid
    expect(trial["1910"]).toBe(12_550 - 1_255);
    expect(trial["2990"]).toBe(-500); // paid some other way: owed to whoever paid
    expect(trial["2871"]).toBe(-12_400);
    expect(trial["1763"]).toBe(255 + 2_519);
    expect(body.incomeStatement.revenueCents).toBe(10_000);
    expect(body.incomeStatement.expensesCents).toBe(1_000 + 500 + 9_881);
    expect(body.journal.map((entry: Json) => entry.voucher)).toEqual([1, 2, 3, 4, 5]);
    expect(body.notes.suspenseCents).toBe(500);
  });

  it("carries an earlier year's result into the balance sheet and keeps other owners out", async () => {
    await salesInvoice("2025-11-01", 5_000);
    const other = await createUser();
    await createReceipt(other.id, { date: "2026-02-01", totalAmountCents: 9_999, reviewStatus: "approved" });
    const body = await books(2026);
    expect(body.journal).toHaveLength(0);
    expect(body.balanceSheet.equity.find((line: Json) => line.code === "2250").cents).toBe(5_000);
    expect(body.balanceSheet.assetsCents).toBe(body.balanceSheet.liabilitiesAndEquityCents);
  });

  it("exports the journal as a Finnish CSV", async () => {
    await createReceipt(user.id, { date: "2026-04-01", totalAmountCents: 1_255, vatDetails: '[{"rate":25.5,"amount":2.55}]', reviewStatus: "approved", vendor: "K; Market" });
    const response = await ledgerExport(buildRequest("GET", "/api/ledger/export?year=2026&report=paivakirja", undefined, { cookie }));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("Tosite;Päivä;Selite;Tili");
    expect(text).toContain('"Kuitti K; Market"');
    expect(text).toContain("10,00");
  });
});
