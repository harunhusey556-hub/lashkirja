import { beforeEach, describe, expect, it } from "vitest";
import { GET as dashboard } from "@/app/api/dashboard/route";
import { GET as monthStatus } from "@/app/api/dashboard/month/route";
import { GET as alv } from "@/app/api/alv/route";
import { PATCH as filing } from "@/app/api/alv/filing/route";
import { prisma } from "@/lib/db";
import { createReferenceNumber } from "@/lib/finnish-reference";
import { resetRateLimitsForTests } from "@/lib/rate-limit";
import { helsinkiMonthKey } from "@/lib/validation";
import {
  createReceipt,
  createStatementWithTransactions,
  createUser,
  resetDatabase,
  type TestUser,
} from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

/**
 * Koti tells the truth about the month (FP-2, FP-3, TF-04, TF-06, TF-11) and
 * the month has a finish line (FP-13, TF-07, TF-16).
 */

let user: TestUser;
let cookie: string;
let refCounter = 5_000_000;

function monthShift(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const current = helsinkiMonthKey();
const previous = monthShift(current, -1);

async function makeInvoice(status: string, issueDate: string, grossCents = 24_500) {
  const customer = await prisma.customer.create({ data: { userId: user.id, name: "Anna Asiakas" } });
  refCounter += 1;
  return prisma.salesInvoice.create({
    data: {
      userId: user.id,
      customerId: customer.id,
      number: refCounter - 5_000_000,
      reference: createReferenceNumber(refCounter),
      issueDate: new Date(`${issueDate}T00:00:00.000Z`),
      dueDate: new Date(`${issueDate}T00:00:00.000Z`),
      status,
      grossCents,
      netCents: Math.round(grossCents / 1.255),
      vatCents: grossCents - Math.round(grossCents / 1.255),
    },
  });
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function getDashboard(month: string): Promise<Json> {
  const response = await dashboard(buildRequest("GET", `/api/dashboard?month=${month}`, undefined, { cookie }));
  expect(response.status).toBe(200);
  return readJson(response);
}

/** The FP-2 invariants for any fixture. */
function expectTruthful(body: Json) {
  const totals = body.itemTotals as Record<string, number>;
  const blockingSum = Object.entries(totals)
    .filter(([kind]) => kind !== "overdue_invoice")
    .reduce((sum, [, n]) => sum + n, 0);
  expect(body.blockingTotal).toBe(blockingSum);
  const rowKinds =
    (totals.missing_receipt ?? 0) +
    (totals.receipt_match ?? 0) +
    (totals.invoice_match ?? 0) +
    (totals.pending_receipt ?? 0);
  expect(body.matching.matchable - body.matching.matched).toBeLessThanOrEqual(rowKinds);
}

beforeEach(async () => {
  resetRateLimitsForTests();
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

describe("GET /api/dashboard: Koti tells the truth (FP-2)", () => {
  it("counts a bank row that settled an invoice as done, and covers every open row with a task", async () => {
    const statement = await createStatementWithTransactions(user.id, {
      periodMonth: previous,
      transactions: [
        { date: `${previous}-28`, amountCents: 24_500, counterparty: "Anna Asiakas" },
        { date: `${previous}-06`, amountCents: -13_900, counterparty: "Ripsitukku Oy" },
        { date: `${previous}-13`, amountCents: -4_500, counterparty: "Sähköyhtiö" },
      ],
    });
    const [income, supplies, power] = statement.transactions;
    // The +245,00 € row settled a sales invoice: it is documented (the August defect).
    const invoice = await makeInvoice("paid", `${previous}-01`);
    await prisma.invoicePayment.create({
      data: { invoiceId: invoice.id, transactionId: income!.id, paidDate: income!.date!, amountCents: 24_500, source: "bank" },
    });
    // One row has a receipt, one has nothing.
    const receipt = await createReceipt(user.id, { date: `${previous}-06`, totalAmountCents: 13_900 });
    await prisma.transaction.update({ where: { id: supplies!.id }, data: { receiptId: receipt.id, matchStatus: "confirmed" } });

    const body = await getDashboard(previous);
    expect(body.matching).toMatchObject({ matchable: 3, matched: 2 });
    expect(body.itemTotals.missing_receipt).toBe(1);
    expect(body.items.find((item: Json) => item.kind === "missing_receipt").transactionId).toBe(power!.id);
    expect(body.blockingTotal).toBe(1);
    expectTruthful(body);
  });

  it("keeps an overdue sales invoice out of the month-close headline", async () => {
    await makeInvoice("sent", "2026-01-10");
    await createReceipt(user.id, { reviewStatus: "pending", date: `${current}-02` });

    const body = await getDashboard(current);
    expect(body.itemTotals.overdue_invoice).toBe(1);
    expect(body.itemTotals.pending_receipt).toBe(1);
    expect(body.blockingTotal).toBe(1);
    expectTruthful(body);
  });

  it("marks a pending receipt without an amount as needing completion (FP-6)", async () => {
    await createReceipt(user.id, { reviewStatus: "pending", totalAmountCents: null, date: `${current}-03` });
    const body = await getDashboard(current);
    const item = body.items.find((entry: Json) => entry.kind === "pending_receipt");
    expect(item.gaps).toEqual(["amount"]);
  });

  it("lists a past month's income draft by its bank row even when the draft is dated outside the month", async () => {
    const statement = await createStatementWithTransactions(user.id, {
      periodMonth: previous,
      transactions: [{ date: `${current}-01`, amountCents: 6_100, counterparty: "Asiakas" }],
    });
    const row = statement.transactions[0]!;
    await prisma.receipt.create({
      data: {
        userId: user.id,
        type: "tulo",
        date: new Date(`${current}-01T00:00:00.000Z`),
        totalAmountCents: 6_100,
        vendor: "Asiakas",
        reviewStatus: "pending",
        sourceTransactionId: row.id,
        filePath: "/tmp/x.pdf",
        fileName: "x.pdf",
      },
    });

    const body = await getDashboard(previous);
    expect(body.itemTotals.pending_receipt).toBe(1);
    expect(body.itemTotals.missing_receipt).toBe(0);
    expectTruthful(body);
  });

  it("shows last month on the current month until it is closed (FP-3)", async () => {
    await createStatementWithTransactions(user.id, {
      periodMonth: previous,
      transactions: [{ date: `${previous}-10`, amountCents: -2_000, counterparty: "Kauppa" }],
    });

    let body = await getDashboard(current);
    expect(body.previousMonth).toEqual({ month: previous, open: 1 });

    await prisma.user.update({ where: { id: user.id }, data: { booksLockedThrough: previous } });
    body = await getDashboard(current);
    expect(body.previousMonth).toBeNull();
  });

  it("gives a new account a start checklist instead of 'all done' (TF-06)", async () => {
    const body = await getDashboard(current);
    expect(body.setup).toEqual({ receipts: false, bank: false, seller: false, empty: true });
    expect(body.blockingTotal).toBe(0);
    expect(body.previousMonth).toBeNull();
    // A user created now opened the account this month.
    expect(body.accountCreatedMonth).toBe(current);
  });

  it("names the Helsinki month the account was opened, so Koti skips older VAT returns", async () => {
    // 22:30 UTC on 31 July is already 1 August in Helsinki.
    await prisma.user.update({ where: { id: user.id }, data: { createdAt: new Date("2026-07-31T22:30:00.000Z") } });
    const body = await getDashboard(current);
    expect(body.accountCreatedMonth).toBe("2026-08");
  });
});

describe("GET /api/dashboard/month: the month close checklist (FP-13)", () => {
  it("lists every open thing of the month, uncapped, and knows whether the month is closed", async () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({
      date: `${previous}-1${index}`,
      amountCents: -1_000 - index,
      counterparty: `Kauppa ${index}`,
    }));
    await createStatementWithTransactions(user.id, { periodMonth: previous, transactions: rows });
    await makeInvoice("draft", `${previous}-20`);

    const response = await monthStatus(buildRequest("GET", `/api/dashboard/month?month=${previous}`, undefined, { cookie }));
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.ended).toBe(true);
    expect(body.locked).toBe(false);
    expect(body.items.filter((item: Json) => item.kind === "missing_receipt")).toHaveLength(5);
    expect(body.totals.draft_invoice).toBe(1);
    expect(body.blockingTotal).toBe(6);
    expect(body.progress).toMatchObject({ matchable: 5, matched: 0 });

    // The Koti summary of that month and the checklist are one fact.
    const koti = await getDashboard(current);
    expect(koti.previousMonth.open).toBe(body.blockingTotal);
  });
});

describe("VAT filing record (FP-13, TF-16, TF-11)", () => {
  async function patch(body: unknown) {
    return filing(buildRequest("PATCH", "/api/alv/filing", body, { cookie }));
  }
  async function getAlv(period: string): Promise<Json> {
    const response = await alv(buildRequest("GET", `/api/alv?period=${period}`, undefined, { cookie }));
    expect(response.status).toBe(200);
    return readJson(response);
  }

  it("records filed and paid, snapshots the figure, and undoes both", async () => {
    await createReceipt(user.id, { type: "tulo", date: `${previous}-05`, totalAmountCents: 12_550 });

    let body = await getAlv(previous);
    expect(body.field308.amount).toBeGreaterThan(0);
    expect(body.filing).toBeNull();

    const paidFirst = await patch({ period: previous, paid: true });
    expect(paidFirst.status).toBe(409);

    const filed = await patch({ period: previous, filed: true });
    expect(filed.status).toBe(200);
    const filedBody = await readJson(filed);
    expect(filedBody.filing.filedAt).toBeTruthy();
    expect(filedBody.filing.filedAmount).toBe(body.field308.isRefund ? -body.field308.amount : body.field308.amount);

    expect((await patch({ period: previous, paid: true })).status).toBe(200);
    body = await getAlv(previous);
    expect(body.filing.paidAt).toBeTruthy();

    expect((await patch({ period: previous, filed: false })).status).toBe(200);
    body = await getAlv(previous);
    expect(body.filing).toBeNull();
  });

  it("says firstFiled only for the account's very first filing, even after an undo", async () => {
    const first = await readJson(await patch({ period: previous, filed: true }));
    expect(first.firstFiled).toBe(true);
    // Marking paid, or filing the same period again, is not a first.
    expect((await readJson(await patch({ period: previous, paid: true }))).firstFiled).toBe(false);
    expect((await readJson(await patch({ period: previous, filed: true }))).firstFiled).toBe(false);
    // Undo and file again: the moment was already shown once.
    await patch({ period: previous, filed: false });
    expect((await readJson(await patch({ period: previous, filed: true }))).firstFiled).toBe(false);
    // Another account has its own first.
    const other = await createUser();
    const otherCookie = await sessionCookie(other);
    const theirs = await readJson(
      await filing(buildRequest("PATCH", "/api/alv/filing", { period: previous, filed: true }, { cookie: otherCookie }))
    );
    expect(theirs.firstFiled).toBe(true);
  });

  it("refuses to mark a period that has not ended", async () => {
    const response = await patch({ period: current, filed: true });
    expect(response.status).toBe(409);
    expect((await patch({ period: "2099-Q1", filed: true })).status).toBe(409);
  });

  it("refuses a malformed period", async () => {
    expect((await patch({ period: "2026-13", filed: true })).status).toBe(400);
    expect((await patch({ period: previous })).status).toBe(400);
  });

  it("keeps one user's filing away from another", async () => {
    await patch({ period: previous, filed: true });
    const other = await createUser();
    const otherCookie = await sessionCookie(other);
    const response = await alv(buildRequest("GET", `/api/alv?period=${previous}`, undefined, { cookie: otherCookie }));
    expect((await readJson(response)).filing).toBeNull();
  });

  it("counts the pending receipts the VAT figure does not contain yet (TF-11)", async () => {
    await createReceipt(user.id, { reviewStatus: "pending", date: `${previous}-12` });
    await createReceipt(user.id, { reviewStatus: "pending", date: `${previous}-13` });
    await createReceipt(user.id, { reviewStatus: "approved", date: `${previous}-14` });
    const body = await getAlv(previous);
    expect(body.pendingReceiptCount).toBe(2);
  });
});
