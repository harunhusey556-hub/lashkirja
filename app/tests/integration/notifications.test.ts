import { beforeEach, describe, expect, it } from "vitest";
import { GET as getNotifications } from "@/app/api/notifications/route";
import { prisma } from "@/lib/db";
import { createReferenceNumber } from "@/lib/finnish-reference";
import { buildNotificationFeed, MAX_NOTIFICATIONS } from "@/lib/notifications";
import { createReceipt, createStatementWithTransactions, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

/**
 * GET /api/notifications: what the iPhone app turns into local notifications.
 * Owner-scoped, bounded, and `since` narrows only the event kinds (new bank rows,
 * new e-mail receipts); state kinds (a late invoice, a VAT return due) always come.
 */

let user: TestUser;
let cookie: string;
const DAY = 24 * 60 * 60 * 1000;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function fetchFeed(query = ""): Promise<Json> {
  const response = await getNotifications(buildRequest("GET", `/api/notifications${query}`, undefined, { cookie }));
  expect(response.status).toBe(200);
  return readJson(response);
}

async function expenseRows(userId: string, periodMonth: string, amounts: number[], counterparty = "K-Market") {
  const statement = await createStatementWithTransactions(userId, {
    periodMonth,
    transactions: amounts.map((amountCents, index) => ({
      date: `${periodMonth}-${String(10 + (index % 18)).padStart(2, "0")}`,
      amountCents,
      counterparty,
    })),
  });
  return prisma.transaction.findMany({ where: { statementId: statement.id }, orderBy: { date: "asc" } });
}

let invoiceNumber = 100;
async function sentInvoice(dueDate: string, grossCents = 12_000) {
  invoiceNumber += 1;
  const customer = await prisma.customer.create({ data: { userId: user.id, name: "Anna Asiakas" } });
  return prisma.salesInvoice.create({
    data: {
      userId: user.id,
      customerId: customer.id,
      number: invoiceNumber,
      reference: createReferenceNumber(8_000_000 + invoiceNumber),
      issueDate: new Date(Date.parse(`${dueDate}T00:00:00.000Z`) - 14 * DAY),
      dueDate: new Date(`${dueDate}T00:00:00.000Z`),
      status: "sent",
      grossCents,
      netCents: grossCents,
      vatCents: 0,
    },
  });
}

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

describe("GET /api/notifications", () => {
  it("requires a session", async () => {
    const response = await getNotifications(buildRequest("GET", "/api/notifications"));
    expect(response.status).toBe(401);
  });

  it("refuses a since that is not a date", async () => {
    const response = await getNotifications(
      buildRequest("GET", "/api/notifications?since=eilen", undefined, { cookie })
    );
    expect(response.status).toBe(400);
  });

  it("answers an empty feed with a cursor for the next call", async () => {
    const before = Date.now();
    const body = await fetchFeed();
    // Calendar reminders (the VAT due date, month close) come and go with the day the test
    // runs: from the 9th to the 12th the VAT reminder is in the feed (failed 2026-10-09).
    expect(body.items.filter((entry: { kind: string }) => entry.kind === "missing_receipt")).toEqual([]);
    // A minute behind now on purpose (overlap); the phone drops repeats by id.
    expect(Date.parse(body.cursor)).toBeGreaterThanOrEqual(before - 2 * 60 * 1000);
    expect(Date.parse(body.cursor)).toBeLessThanOrEqual(Date.now());
    expect(body.counts.missing_receipt).toBe(0);
  });

  it("lists an expense bank row without a receipt, and nothing of another owner", async () => {
    const [row] = await expenseRows(user.id, "2026-09", [-2_490]);
    // Income, an already documented expense, and another owner's row are not asked about.
    await expenseRows(user.id, "2026-09", [5_000]);
    const [documented] = await expenseRows(user.id, "2026-09", [-1_000]);
    await prisma.transaction.update({ where: { id: documented.id }, data: { matchStatus: "confirmed" } });
    const other = await createUser();
    await expenseRows(other.id, "2026-09", [-777]);

    const body = await fetchFeed();
    // Only the missing-receipt items: a month-close reminder joins them once the
    // calendar has passed September, which depends on the day the test runs.
    const missing = body.items.filter((entry: { kind: string }) => entry.kind === "missing_receipt");
    expect(missing).toHaveLength(1);
    const item = missing[0];
    expect(item).toMatchObject({
      id: `missing-receipt:${row.id}`,
      kind: "missing_receipt",
      title: "Kuitti puuttuu",
      href: `/pankki/tapahtumat?month=2026-09&nayta=toimet&rivi=${row.id}`,
    });
    expect(item.body).toContain("K-Market");
    expect(item.body).toContain("24,90");
    expect(typeof item.createdAt).toBe("string");
    expect(body.counts.missing_receipt).toBe(1);
  });

  it("leaves out bank rows of a closed month", async () => {
    await expenseRows(user.id, "2026-08", [-1_500]);
    await prisma.user.update({ where: { id: user.id }, data: { booksLockedThrough: "2026-08" } });
    const body = await fetchFeed();
    expect(body.items.filter((entry: { kind: string }) => entry.kind === "missing_receipt")).toEqual([]);
    expect(body.counts.missing_receipt).toBe(0);
  });

  it("since narrows bank rows by import time, not the state items", async () => {
    const [oldRow] = await expenseRows(user.id, "2026-09", [-1_000]);
    await prisma.transaction.update({ where: { id: oldRow.id }, data: { createdAt: new Date(Date.now() - 2 * DAY) } });
    const [newRow] = await expenseRows(user.id, "2026-09", [-2_000]);
    const invoice = await sentInvoice("2026-01-20");

    const since = new Date(Date.now() - DAY).toISOString();
    const body = await fetchFeed(`?since=${encodeURIComponent(since)}`);
    const ids = body.items.map((item: Json) => item.id);
    expect(ids).toContain(`missing-receipt:${newRow.id}`);
    expect(ids).not.toContain(`missing-receipt:${oldRow.id}`);
    expect(ids).toContain(`overdue-invoice:${invoice.id}:0`);
    // The count is what is open now, whatever `since` says (the daily summary reads it).
    expect(body.counts.missing_receipt).toBe(2);
  });

  it("is bounded however much is open", async () => {
    await expenseRows(user.id, "2026-09", Array.from({ length: 30 }, (_, index) => -(100 + index)));
    for (let index = 0; index < 8; index += 1) await sentInvoice("2026-01-20");
    const body = await fetchFeed();
    expect(body.items.length).toBeLessThanOrEqual(MAX_NOTIFICATIONS);
    expect(body.items.filter((item: Json) => item.kind === "missing_receipt").length).toBeLessThanOrEqual(10);
    expect(body.items.some((item: Json) => item.kind === "overdue_invoice")).toBe(true);
    expect(body.counts.missing_receipt).toBe(30);
    expect(body.counts.overdue_invoice).toBe(8);
  });
});

describe("overdue invoices: once per reminder step", () => {
  const now = new Date("2026-10-03T09:00:00.000Z");

  it("names a late invoice once, again only when a new reminder may go", async () => {
    const invoice = await sentInvoice("2026-09-20");
    let feed = await buildNotificationFeed(user.id, { now });
    const first = feed.items.find((item) => item.kind === "overdue_invoice");
    expect(first).toMatchObject({ id: `overdue-invoice:${invoice.id}:0`, href: `/laskut/lasku?id=${invoice.id}` });
    expect(first?.body).toContain("Anna Asiakas");

    // A reminder went out and its term still runs: nothing to do yet.
    await prisma.invoiceReminder.create({
      data: {
        invoiceId: invoice.id,
        level: 1,
        sentAt: new Date("2026-10-01T09:00:00.000Z"),
        sentTo: "anna@example.com",
        dueDate: new Date("2026-10-15T00:00:00.000Z"),
        openCents: 12_000,
        interestCents: 0,
        feeCents: 500,
        totalCents: 12_500,
        daysLate: 11,
      },
    });
    feed = await buildNotificationFeed(user.id, { now });
    expect(feed.items.filter((item) => item.kind === "overdue_invoice")).toEqual([]);

    // The reminder's term is over: the next step.
    feed = await buildNotificationFeed(user.id, { now: new Date("2026-10-20T09:00:00.000Z") });
    expect(feed.items.find((item) => item.kind === "overdue_invoice")?.id).toBe(`overdue-invoice:${invoice.id}:1`);
  });

  it("leaves out a paid invoice", async () => {
    const invoice = await sentInvoice("2026-09-20");
    await prisma.invoicePayment.create({
      data: { invoiceId: invoice.id, amountCents: 12_000, paidDate: new Date("2026-09-25T00:00:00.000Z"), source: "manual" },
    });
    const feed = await buildNotificationFeed(user.id, { now });
    expect(feed.items.filter((item) => item.kind === "overdue_invoice")).toEqual([]);
  });
});

describe("VAT return due", () => {
  // August 2026 (monthly filer) is due Monday 12.10.2026.
  it("comes within three days of the due date while not filed", async () => {
    const feed = await buildNotificationFeed(user.id, { now: new Date("2026-10-09T08:00:00.000Z") });
    const item = feed.items.find((entry) => entry.kind === "vat_due");
    expect(item).toMatchObject({ id: "vat-due:2026-08", href: "/kirjanpito/alv?period=2026-08" });
    expect(item?.body).toContain("12.10.");
  });

  it("stays away earlier, once filed, and for an owner who is not VAT registered", async () => {
    expect(
      (await buildNotificationFeed(user.id, { now: new Date("2026-10-01T08:00:00.000Z") })).items.some((i) => i.kind === "vat_due")
    ).toBe(false);

    await prisma.vatFiling.create({ data: { userId: user.id, period: "2026-08", filedAt: new Date("2026-10-08T10:00:00.000Z") } });
    expect(
      (await buildNotificationFeed(user.id, { now: new Date("2026-10-09T08:00:00.000Z") })).items.some((i) => i.kind === "vat_due")
    ).toBe(false);

    const free = await createUser({ vatRegistered: false });
    expect(
      (await buildNotificationFeed(free.id, { now: new Date("2026-10-09T08:00:00.000Z") })).items.some((i) => i.kind === "vat_due")
    ).toBe(false);
  });
});

describe("previous month not closed", () => {
  it("comes after the 5th when last month has bookkeeping and is still open", async () => {
    await createReceipt(user.id, { date: "2026-09-14" });
    const early = await buildNotificationFeed(user.id, { now: new Date("2026-10-05T08:00:00.000Z") });
    expect(early.items.some((item) => item.kind === "month_close")).toBe(false);

    const late = await buildNotificationFeed(user.id, { now: new Date("2026-10-06T08:00:00.000Z") });
    const item = late.items.find((entry) => entry.kind === "month_close");
    expect(item).toMatchObject({ id: "month-close:2026-09", href: "/kirjanpito/kuukausi?month=2026-09" });
    expect(item?.title).toContain("Syyskuu");

    await prisma.user.update({ where: { id: user.id }, data: { booksLockedThrough: "2026-09" } });
    const closed = await buildNotificationFeed(user.id, { now: new Date("2026-10-06T08:00:00.000Z") });
    expect(closed.items.some((entry) => entry.kind === "month_close")).toBe(false);
  });

  it("says nothing about an empty month", async () => {
    const feed = await buildNotificationFeed(user.id, { now: new Date("2026-10-06T08:00:00.000Z") });
    expect(feed.items.some((item) => item.kind === "month_close")).toBe(false);
  });
});

describe("bank sync failures that are still open", () => {
  async function connection(overrides: { status?: string; lastSuccessAt?: Date | null } = {}) {
    return prisma.bankConnection.create({
      data: {
        userId: user.id,
        aspspName: "Nordea",
        aspspCountry: "FI",
        psuType: "business",
        status: overrides.status ?? "active",
        lastSuccessAt: overrides.lastSuccessAt ?? null,
      },
    });
  }

  async function job(resourceId: string, status: string, createdAt: Date) {
    return prisma.backgroundJob.create({
      data: {
        userId: user.id,
        kind: "bank_sync",
        status,
        title: "Pankkitapahtumien haku",
        error: status === "failed" ? "Pankki ei vastannut." : null,
        resourceType: "bank_connection",
        resourceId,
        createdAt,
      },
    });
  }

  it("names a failed sync of a live connection once per streak", async () => {
    const bank = await connection({ lastSuccessAt: new Date(Date.now() - 3 * DAY) });
    await job(bank.id, "failed", new Date(Date.now() - 2 * DAY));
    await job(bank.id, "failed", new Date(Date.now() - DAY));
    const body = await fetchFeed();
    const items = body.items.filter((item: Json) => item.kind === "bank_sync_failed");
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(`bank-sync-failed:${bank.id}:${bank.lastSuccessAt!.toISOString()}`);
    expect(items[0].href).toBe("/tyot");
    expect(items[0].body).toContain("Nordea");
  });

  it("drops a failure a later fetch put right, or whose connection is gone", async () => {
    const fixed = await connection();
    await job(fixed.id, "failed", new Date(Date.now() - 2 * DAY));
    await job(fixed.id, "done", new Date(Date.now() - DAY));

    const succeeded = await connection({ lastSuccessAt: new Date(Date.now() - 1000) });
    await job(succeeded.id, "failed", new Date(Date.now() - DAY));

    const revoked = await connection({ status: "revoked" });
    await job(revoked.id, "failed", new Date(Date.now() - DAY));

    await job("removed-connection", "failed", new Date(Date.now() - DAY));

    const body = await fetchFeed();
    expect(body.items.filter((item: Json) => item.kind === "bank_sync_failed")).toEqual([]);
  });
});

describe("e-mail receipts to review", () => {
  it("lists pending receipts from mail sync, and since narrows them", async () => {
    const mail = await prisma.receipt.create({
      data: {
        userId: user.id,
        vendor: "Elisa Oyj",
        totalAmountCents: 3_990,
        source: "email_sync",
        reviewStatus: "pending",
        filePath: "/tmp/elisa.pdf",
        fileName: "elisa.pdf",
        date: new Date("2026-09-30T00:00:00.000Z"),
      },
    });
    await createReceipt(user.id, { reviewStatus: "pending" });

    const body = await fetchFeed();
    const items = body.items.filter((item: Json) => item.kind === "receipt_review");
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: `receipt-review:${mail.id}`, href: `/kuitit/kuitti?id=${mail.id}` });
    expect(items[0].body).toContain("Elisa Oyj");
    expect(body.counts.receipt_review).toBe(1);

    const later = await fetchFeed(`?since=${encodeURIComponent(new Date(Date.now() + 1000).toISOString())}`);
    expect(later.items.filter((item: Json) => item.kind === "receipt_review")).toEqual([]);
    expect(later.counts.receipt_review).toBe(1);
  });
});
