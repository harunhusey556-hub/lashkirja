import { beforeEach, describe, expect, it } from "vitest";
import { GET as dashboard } from "@/app/api/dashboard/route";
import { prisma } from "@/lib/db";
import { createReferenceNumber } from "@/lib/finnish-reference";
import { resetRateLimitsForTests } from "@/lib/rate-limit";
import { helsinkiMonthKey } from "@/lib/validation";
import { createReceipt, createStatementWithTransactions, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

/** Koti: "Hoidettu automaattisesti" counts real records of the last 7 days, and the month bar counts bank rows and receipts. */

let user: TestUser;
let cookie: string;
const current = helsinkiMonthKey();
const DAY = 24 * 60 * 60 * 1000;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function getDashboard(month = current): Promise<Json> {
  const response = await dashboard(buildRequest("GET", `/api/dashboard?month=${month}`, undefined, { cookie }));
  expect(response.status).toBe(200);
  return readJson(response);
}

async function makeInvoice(number: number) {
  const customer = await prisma.customer.create({ data: { userId: user.id, name: "Anna Asiakas" } });
  return prisma.salesInvoice.create({
    data: {
      userId: user.id,
      customerId: customer.id,
      number,
      reference: createReferenceNumber(7_000_000 + number),
      // Dated outside the month shown, so the invoice itself adds nothing to the month's books.
      issueDate: new Date("2026-01-10T00:00:00.000Z"),
      dueDate: new Date("2026-01-24T00:00:00.000Z"),
      status: "sent",
      grossCents: 10_000,
      netCents: 8_000,
      vatCents: 2_000,
    },
  });
}

beforeEach(async () => {
  resetRateLimitsForTests();
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

describe("GET /api/dashboard: handled", () => {
  it("is null when nothing was done automatically", async () => {
    await createReceipt(user.id, { date: `${current}-02` });
    const body = await getDashboard();
    expect(body.handled).toBeNull();
  });

  it("counts e-mail receipts, reference payments and recurring invoices of the last 7 days only", async () => {
    const old = new Date(Date.now() - 10 * DAY);
    for (let i = 0; i < 3; i += 1) {
      const receipt = await createReceipt(user.id, { reviewStatus: "pending", date: `${current}-02` });
      await prisma.receipt.update({ where: { id: receipt.id }, data: { source: "email_sync" } });
    }
    const stale = await createReceipt(user.id, { date: `${current}-02` });
    await prisma.receipt.update({ where: { id: stale.id }, data: { source: "email_sync", createdAt: old } });
    // A manual photo is the owner's own work, never counted.
    await createReceipt(user.id, { date: `${current}-02` });

    const invoice = await makeInvoice(1);
    const invoiceTwo = await makeInvoice(2);
    await prisma.invoicePayment.create({
      data: { invoiceId: invoice.id, paidDate: new Date(), amountCents: 10_000, source: "bank", note: "Kohdistettu viitenumerolla" },
    });
    // Booked by the owner's own tap on Koti: same source, other note, not automatic.
    await prisma.invoicePayment.create({
      data: { invoiceId: invoiceTwo.id, paidDate: new Date(), amountCents: 10_000, source: "bank", note: null },
    });

    const schedule = await prisma.recurringInvoice.create({
      data: { userId: user.id, customerId: invoice.customerId, interval: "monthly", anchorDay: 1, startDate: new Date("2026-01-01T00:00:00.000Z") },
    });
    await prisma.recurringInvoiceRun.create({ data: { recurringInvoiceId: schedule.id, issueDate: new Date(), status: "created" } });
    await prisma.recurringInvoiceRun.create({
      data: { recurringInvoiceId: schedule.id, issueDate: new Date("2026-01-01T00:00:00.000Z"), status: "failed" },
    });

    const body = await getDashboard();
    expect(body.handled.count).toBe(5);
    expect(body.handled.parts).toEqual([
      { kind: "email_receipt", count: 3, label: "3 kuittia sähköpostista" },
      { kind: "reference_payment", count: 1, label: "1 maksu kohdistettu viitenumerolla" },
      { kind: "recurring_invoice", count: 1, label: "1 toistuva lasku luotu" },
    ]);
  });

  it("belongs to the current month only, and never leaks another user's records", async () => {
    const other = await createUser({ email: "other-handled@lashkirja.test" });
    const receipt = await createReceipt(other.id, { date: `${current}-02` });
    await prisma.receipt.update({ where: { id: receipt.id }, data: { source: "email_sync" } });
    expect((await getDashboard()).handled).toBeNull();

    const mine = await createReceipt(user.id, { date: `${current}-02` });
    await prisma.receipt.update({ where: { id: mine.id }, data: { source: "email_sync" } });
    expect((await getDashboard()).handled.count).toBe(1);
    expect((await getDashboard("2026-01")).handled).toBeNull();
  });
});

describe("GET /api/dashboard: events", () => {
  it("counts bank rows and receipts no bank row accounts for", async () => {
    const statement = await createStatementWithTransactions(user.id, {
      periodMonth: current,
      transactions: [
        { date: `${current}-02`, amountCents: -5_000, counterparty: "A" },
        { date: `${current}-03`, amountCents: -6_000, counterparty: "B" },
      ],
    });
    const linked = await createReceipt(user.id, { date: `${current}-02` });
    await prisma.transaction.update({ where: { id: statement.transactions[0]!.id }, data: { receiptId: linked.id, matchStatus: "confirmed" } });
    await createReceipt(user.id, { date: `${current}-04` }); // approved, no row
    await createReceipt(user.id, { date: `${current}-05`, reviewStatus: "pending" });

    const body = await getDashboard();
    // 2 rows (1 documented) + 1 approved + 1 pending receipt; the linked receipt is the row's own.
    expect(body.events).toEqual({ done: 2, total: 4 });
  });

  it("has no total for an empty month, so Koti draws no bar", async () => {
    expect((await getDashboard()).events).toEqual({ done: 0, total: 0 });
  });
});
