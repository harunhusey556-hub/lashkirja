import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { GET as listReceipts } from "@/app/api/receipts/route";
import { GET as receiptCounts } from "@/app/api/receipts/counts/route";
import { GET as invoiceCounts } from "@/app/api/invoices/counts/route";
import { listInvoices } from "@/lib/sales-invoices";
import { createReferenceNumber } from "@/lib/finnish-reference";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;
let customerId: string;

async function receipt(date: string) {
  await prisma.receipt.create({
    data: {
      userId: user.id,
      type: "meno",
      vendor: "Tukku Oy",
      date: new Date(`${date}T00:00:00Z`),
      totalAmountCents: 1000,
      reviewStatus: "approved",
      filePath: "/tmp/kuitti.pdf",
      fileName: "kuitti.pdf",
    },
  });
}

async function invoice(number: number, issue: string) {
  await prisma.salesInvoice.create({
    data: {
      userId: user.id,
      customerId,
      number,
      reference: createReferenceNumber(4_000_000 + number),
      issueDate: new Date(`${issue}T00:00:00Z`),
      dueDate: new Date(`${issue}T00:00:00Z`),
      status: "paid",
      documentKind: "invoice",
      grossCents: 10_000,
      netCents: 8_000,
      vatCents: 2_000,
    },
  });
}

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  customerId = (await prisma.customer.create({ data: { userId: user.id, name: "Anna Asiakas" } })).id;
});

describe("a yearly report figure opens that year, not every year (V45, R60)", () => {
  it("scopes the receipt list and its counts to the year", async () => {
    await receipt("2025-03-10");
    await receipt("2025-12-31");
    await receipt("2026-01-01");
    const list = await readJson(await listReceipts(buildRequest("GET", "/api/receipts?month=2025", undefined, { cookie })));
    expect(list.receipts).toHaveLength(2);
    const counts = await readJson(await receiptCounts(buildRequest("GET", "/api/receipts/counts?month=2025", undefined, { cookie })));
    expect(counts.counts.all).toBe(2);
  });

  it("scopes the invoice list and its counts to the year", async () => {
    await invoice(1, "2025-06-01");
    await invoice(2, "2026-02-01");
    const list = await listInvoices(user.id, { month: "2025" });
    expect(list.invoices.map((row) => row.number)).toEqual([1]);
    const counts = await readJson(await invoiceCounts(buildRequest("GET", "/api/invoices/counts?month=2025", undefined, { cookie })));
    expect(counts.counts.paid).toBe(1);
  });
});
