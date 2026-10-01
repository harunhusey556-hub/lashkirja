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
