import { beforeEach, describe, expect, it } from "vitest";
import { GET as dashboard } from "@/app/api/dashboard/route";
import { GET as monthStatus } from "@/app/api/dashboard/month/route";
import { prisma } from "@/lib/db";
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
 * Lane H, honesty of Koti, the month close and the VAT return (F10, F72, F39).
 * A month that holds nothing must say so, and a receipt the VAT return cannot
 * use is an open item, not a ready month.
 */

let user: TestUser;
let cookie: string;

function monthShift(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

const current = helsinkiMonthKey();
const previous = monthShift(current, -1);
const older = monthShift(current, -2);

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function getMonth(month: string): Promise<Json> {
  const response = await monthStatus(buildRequest("GET", `/api/dashboard/month?month=${month}`, undefined, { cookie }));
  expect(response.status).toBe(200);
  return readJson(response);
}

async function getDashboard(month: string): Promise<Json> {
  const response = await dashboard(buildRequest("GET", `/api/dashboard?month=${month}`, undefined, { cookie }));
  expect(response.status).toBe(200);
  return readJson(response);
}

beforeEach(async () => {
  resetRateLimitsForTests();
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

describe("an empty month is not a finished one (F10)", () => {
  it("reports that nothing is recorded in a month with no statement, receipt or invoice", async () => {
    const body = await getMonth(older);
    expect(body.hasContent).toBe(false);
    expect(body.hasStatement).toBe(false);
    expect(body.receiptCount).toBe(0);
    expect(body.invoiceCount).toBe(0);
    expect(body.blockingTotal).toBe(0);
  });

  it("reports a future month the same way", async () => {
    const body = await getMonth(monthShift(current, 2));
    expect(body.ended).toBe(false);
    expect(body.hasContent).toBe(false);
  });

  it("sees a receipt, a statement or an invoice dated in the month", async () => {
    await createReceipt(user.id, { date: `${older}-10` });
    let body = await getMonth(older);
    expect(body.hasContent).toBe(true);
    expect(body.receiptCount).toBe(1);
    expect(body.hasStatement).toBe(false);

    await createStatementWithTransactions(user.id, {
      periodMonth: previous,
      transactions: [{ date: `${previous}-10`, amountCents: -1_000 }],
    });
    body = await getMonth(previous);
    expect(body.hasContent).toBe(true);
    expect(body.hasStatement).toBe(true);
  });
});

describe("an approved receipt without a VAT breakdown is an open item (F72)", () => {
  async function noBreakdownReceipt(date: string, overrides: Parameters<typeof createReceipt>[1] = {}) {
    return createReceipt(user.id, { date, vatDetails: null, totalAmountCents: 4_000, vendor: "Ilman erittelyä", ...overrides });
  }

  it("blocks the month for a VAT-registered owner and names the receipt", async () => {
    const receipt = await noBreakdownReceipt(`${previous}-12`);
    const body = await getMonth(previous);
    expect(body.totals.vat_gap).toBe(1);
    expect(body.blockingTotal).toBe(1);
    expect(body.hasContent).toBe(true);
    const item = body.items.find((entry: Json) => entry.kind === "vat_gap");
    expect(item).toMatchObject({ receiptId: receipt.id, party: "Ilman erittelyä", amount: 40, type: "meno" });

    // Koti's summary of last month is the same fact.
    const koti = await getDashboard(current);
    expect(koti.previousMonth).toEqual({ month: previous, open: 1 });
  });

  it("is resolved by adding the VAT breakdown", async () => {
    const receipt = await noBreakdownReceipt(`${previous}-12`);
    await prisma.receipt.update({
      where: { id: receipt.id },
      data: { vatDetails: JSON.stringify([{ rate: 25.5, amount: 8.13 }]) },
    });
    const body = await getMonth(previous);
    expect(body.totals.vat_gap).toBe(0);
    expect(body.blockingTotal).toBe(0);
  });

  it("is not raised for an owner who is not VAT registered", async () => {
    await prisma.user.update({ where: { id: user.id }, data: { vatRegistered: false } });
    await noBreakdownReceipt(`${previous}-12`);
    const body = await getMonth(previous);
    expect(body.totals.vat_gap).toBe(0);
    expect(body.blockingTotal).toBe(0);
  });

  it("ignores a pending receipt (it is already a pending item) and a receipt of another month", async () => {
    await noBreakdownReceipt(`${previous}-12`, { reviewStatus: "pending" });
    await noBreakdownReceipt(`${older}-12`);
    const body = await getMonth(previous);
    expect(body.totals.vat_gap).toBe(0);
    expect(body.totals.pending_receipt).toBe(1);
  });

  it("agrees with the ALV page about which receipts the return cannot use", async () => {
    await noBreakdownReceipt(`${previous}-12`);
    await createReceipt(user.id, { date: `${previous}-13` });
    const { GET: alv } = await import("@/app/api/alv/route");
    const response = await alv(buildRequest("GET", `/api/alv?period=${previous}`, undefined, { cookie }));
    const report = await readJson(response);
    const body = await getMonth(previous);
    expect(report.review.count).toBe(1);
    expect(body.totals.vat_gap).toBe(report.review.count);
  });
});

describe("a yearly filer has an annual view of the return (F13)", () => {
  it("answers /api/alv for a bare year, sums the whole calendar year and files it", async () => {
    const { GET: alv } = await import("@/app/api/alv/route");
    const { PATCH: filing } = await import("@/app/api/alv/filing/route");
    await createReceipt(user.id, { type: "tulo", date: "2025-03-05", totalAmountCents: 12_550 });
    await createReceipt(user.id, { type: "tulo", date: "2025-11-20", totalAmountCents: 12_550 });
    await createReceipt(user.id, { type: "tulo", date: "2026-01-02", totalAmountCents: 12_550 });

    const response = await alv(buildRequest("GET", "/api/alv?period=2025", undefined, { cookie }));
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.period.key).toBe("2025");
    expect(body.period.start).toBe("2025-01-01T00:00:00.000Z");
    expect(body.receiptCount).toBe(2);
    expect(body.field308.amount).toBeGreaterThan(0);

    const filed = await filing(buildRequest("PATCH", "/api/alv/filing", { period: "2025", filed: true }, { cookie }));
    expect(filed.status).toBe(200);
    const again = await readJson(await alv(buildRequest("GET", "/api/alv?period=2025", undefined, { cookie })));
    expect(again.filing.filedAmount).toBe(body.field308.amount);
  });

  it("still refuses a malformed period", async () => {
    const { GET: alv } = await import("@/app/api/alv/route");
    for (const bad of ["20256", "2025-13", "2025-Q5", "abc"]) {
      const response = await alv(buildRequest("GET", `/api/alv?period=${bad}`, undefined, { cookie }));
      expect(response.status).toBe(400);
    }
  });
});

describe("a purchase invoice's VAT reaches the ALV return once, never twice (F39)", () => {
  async function alvOf(period: string): Promise<Json> {
    const { GET: alv } = await import("@/app/api/alv/route");
    const response = await alv(buildRequest("GET", `/api/alv?period=${period}`, undefined, { cookie }));
    expect(response.status).toBe(200);
    return readJson(response);
  }

  async function purchase(overrides: Record<string, unknown> = {}) {
    return prisma.purchaseInvoice.create({
      data: {
        userId: user.id,
        supplierName: "Ripsitukku Oy",
        issueDate: new Date(`${previous}-10T00:00:00.000Z`),
        dueDate: new Date(`${previous}-24T00:00:00.000Z`),
        status: "open",
        grossCents: 12_400,
        vatCents: 2_519,
        netCents: 9_881,
        ...overrides,
      },
    });
  }

  it("counts a recorded purchase invoice's VAT as deductible, by invoice date", async () => {
    const before = await alvOf(previous);
    await purchase();
    const after = await alvOf(previous);
    expect(after.field307.amount).toBeCloseTo(before.field307.amount + 25.19, 2);
    expect(after.sources.purchaseInvoiceCount).toBe(1);
    expect(after.sources.purchaseInvoiceVat).toBe(25.19);
    // The invoice dated in another month does not move this one.
    await purchase({ issueDate: new Date(`${older}-10T00:00:00.000Z`) });
    expect((await alvOf(previous)).field307.amount).toBe(after.field307.amount);
    // A paid invoice counts as well, a cancelled one never.
    await purchase({ status: "paid", vatCents: 100 });
    await purchase({ status: "cancelled", vatCents: 99_900 });
    expect((await alvOf(previous)).sources.purchaseInvoiceVat).toBe(26.19);
  });

  it("leaves the invoice out when an approved receipt it is linked to already counts that purchase", async () => {
    const receipt = await createReceipt(user.id, { date: `${previous}-10`, totalAmountCents: 12_400 });
    await purchase({ receiptId: receipt.id });
    const body = await alvOf(previous);
    expect(body.sources.purchaseInvoiceCount).toBe(0);
    expect(body.skippedPurchaseInvoiceCount).toBe(1);
    // The receipt's own VAT (25,50 in the fixture) is the only deduction.
    expect(body.field307.amount).toBe(25.5);
  });

  it("keeps the invoice when its linked receipt is still pending", async () => {
    const receipt = await createReceipt(user.id, { date: `${previous}-10`, reviewStatus: "pending" });
    await purchase({ receiptId: receipt.id });
    const body = await alvOf(previous);
    expect(body.sources.purchaseInvoiceCount).toBe(1);
    expect(body.skippedPurchaseInvoiceCount).toBe(0);
  });

  it("leaves the invoice out when the bank row that paid it is documented by an approved receipt", async () => {
    const statement = await createStatementWithTransactions(user.id, {
      periodMonth: previous,
      transactions: [{ date: `${previous}-12`, amountCents: -12_400, counterparty: "Ripsitukku Oy" }],
    });
    const row = statement.transactions[0]!;
    const receipt = await createReceipt(user.id, { date: `${previous}-12`, totalAmountCents: 12_400 });
    await prisma.transaction.update({ where: { id: row.id }, data: { receiptId: receipt.id, matchStatus: "confirmed" } });
    const invoice = await purchase();
    await prisma.purchasePayment.create({
      data: { purchaseInvoiceId: invoice.id, transactionId: row.id, paidDate: new Date(`${previous}-12T00:00:00.000Z`), amountCents: 12_400, source: "bank" },
    });
    const body = await alvOf(previous);
    expect(body.sources.purchaseInvoiceCount).toBe(0);
    expect(body.skippedPurchaseInvoiceCount).toBe(1);
  });

  it("counts both and flags it when an unlinked receipt has the same amount close in date", async () => {
    await createReceipt(user.id, { date: `${previous}-12`, totalAmountCents: 12_400 });
    await purchase();
    const body = await alvOf(previous);
    expect(body.sources.purchaseInvoiceCount).toBe(1);
    expect(body.suspectedPurchaseDuplicateCount).toBe(1);
    // A receipt of another amount raises nothing.
    await prisma.purchaseInvoice.deleteMany();
    await purchase({ grossCents: 99_999 });
    expect((await alvOf(previous)).suspectedPurchaseDuplicateCount).toBe(0);
  });

  it("feeds the filed snapshot, so the return and the filing agree", async () => {
    const { PATCH: filing } = await import("@/app/api/alv/filing/route");
    await purchase();
    const body = await alvOf(previous);
    const filed = await readJson(await filing(buildRequest("PATCH", "/api/alv/filing", { period: previous, filed: true }, { cookie })));
    expect(filed.filing.filedAmount).toBe(body.field308.isRefund ? -body.field308.amount : body.field308.amount);
    expect(body.field308.isRefund).toBe(true);
  });
});
