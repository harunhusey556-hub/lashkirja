import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { GET as getCounts } from "@/app/api/purchase-invoices/counts/route";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;

/** UTC midnight N days from today - due dates are always stored this way. */
function utcMidnight(daysFromToday: number): Date {
  const now = new Date();
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(base + daysFromToday * 86_400_000);
}

interface RowOverrides {
  status: string;
  dueDate?: Date;
  userId?: string;
}

async function makeRow(overrides: RowOverrides) {
  return prisma.purchaseInvoice.create({
    data: {
      userId: overrides.userId ?? user.id,
      supplierName: "Tukku Oy",
      issueDate: utcMidnight(-60),
      dueDate: overrides.dueDate ?? utcMidnight(30),
      status: overrides.status,
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
});

describe("countPurchaseInvoicesByDisplayStatus / GET /api/purchase-invoices/counts", () => {
  it("counts by display status - open is overdue only once its due date has fully passed - scoped by user", async () => {
    const otherUser = await createUser();

    await makeRow({ status: "open", dueDate: utcMidnight(30) }); // open, not due
    await makeRow({ status: "open", dueDate: utcMidnight(-1) }); // overdue (due yesterday)
    await makeRow({ status: "open", dueDate: utcMidnight(0) }); // due today - not overdue yet
    await makeRow({ status: "paid" }); // paid
    await makeRow({ status: "cancelled" }); // cancelled
    await makeRow({ status: "open", dueDate: utcMidnight(-10), userId: otherUser.id }); // another user entirely, overdue - must never be counted

    const body = await readJson(
      await getCounts(buildRequest("GET", "/api/purchase-invoices/counts", undefined, { cookie }))
    );
    expect(body.counts).toEqual({ open: 2, overdue: 1, paid: 1, cancelled: 1 });
  });

  it("requires a session and returns the same numbers once signed in", async () => {
    await makeRow({ status: "open", dueDate: utcMidnight(30) });

    const signedOut = await getCounts(buildRequest("GET", "/api/purchase-invoices/counts"));
    expect(signedOut.status).toBe(401);

    const signedIn = await getCounts(
      buildRequest("GET", "/api/purchase-invoices/counts", undefined, { cookie })
    );
    expect(signedIn.status).toBe(200);
    expect((await readJson(signedIn)).counts).toEqual({
      open: 1,
      overdue: 0,
      paid: 0,
      cancelled: 0,
    });
  });
});
