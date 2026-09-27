import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { GET as getCounts } from "@/app/api/invoices/counts/route";
import { listInvoices } from "@/lib/sales-invoices";
import { createReferenceNumber } from "@/lib/finnish-reference";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson } from "./helpers/http";
import { sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;
let customerId: string;
let refCounter = 3_000_000;

/** UTC midnight N days from today - due dates are always stored this way. */
function utcMidnight(daysFromToday: number): Date {
  const now = new Date();
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(base + daysFromToday * 86_400_000);
}

function nextReference(): string {
  refCounter += 1;
  return createReferenceNumber(refCounter);
}

interface RowOverrides {
  number: number;
  status: string;
  dueDate?: Date;
  documentKind?: string;
  customerId?: string;
}

async function makeRow(overrides: RowOverrides) {
  return prisma.salesInvoice.create({
    data: {
      userId: user.id,
      customerId: overrides.customerId ?? customerId,
      number: overrides.number,
      reference: nextReference(),
      issueDate: utcMidnight(-60),
      dueDate: overrides.dueDate ?? utcMidnight(30),
      status: overrides.status,
      documentKind: overrides.documentKind ?? "invoice",
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

describe("countInvoicesByDisplayStatus / GET /api/invoices/counts", () => {
  it("counts by display status - credit notes never overdue, sent is overdue only after the due day ends - scoped by user and customer", async () => {
    const otherCustomer = await prisma.customer.create({
      data: { userId: user.id, name: "Toinen asiakas" },
    });
    const otherUser = await createUser();
    const otherUsersCustomer = await prisma.customer.create({
      data: { userId: otherUser.id, name: "Vieras" },
    });

    await makeRow({ number: 1, status: "draft" }); // draft
    await makeRow({ number: 2, status: "sent", dueDate: utcMidnight(30) }); // sent, not due
    await makeRow({ number: 3, status: "sent", dueDate: utcMidnight(-1) }); // overdue (due yesterday)
    await makeRow({ number: 4, status: "sent", dueDate: utcMidnight(0) }); // due today - not overdue yet
    await makeRow({ number: 5, status: "paid" }); // paid
    await makeRow({ number: 6, status: "credited" }); // credited
    await makeRow({
      number: 7,
      status: "sent",
      documentKind: "credit_note",
      dueDate: utcMidnight(-10),
    }); // credit note in sent status, past due - must stay "sent", never "overdue"
    await makeRow({
      number: 8,
      status: "sent",
      dueDate: utcMidnight(30),
      customerId: otherCustomer.id,
    }); // other customer, same user - counted overall, excluded when scoped
    await prisma.salesInvoice.create({
      data: {
        userId: otherUser.id,
        customerId: otherUsersCustomer.id,
        number: 1,
        reference: nextReference(),
        issueDate: utcMidnight(-60),
        dueDate: utcMidnight(-1),
        status: "sent",
        documentKind: "invoice",
        grossCents: 100,
        netCents: 80,
        vatCents: 20,
      },
    }); // another user entirely, overdue - must never be counted

    const overall = await readJson(
      await getCounts(buildRequest("GET", "/api/invoices/counts", undefined, { cookie }))
    );
    expect(overall.counts).toEqual({ draft: 1, sent: 4, overdue: 1, paid: 1, credited: 1 });

    const scoped = await readJson(
      await getCounts(
        buildRequest("GET", `/api/invoices/counts?customerId=${customerId}`, undefined, { cookie })
      )
    );
    expect(scoped.counts).toEqual({ draft: 1, sent: 3, overdue: 1, paid: 1, credited: 1 });
  });

  it("requires a session and returns the same numbers once signed in", async () => {
    await makeRow({ number: 1, status: "draft" });

    const signedOut = await getCounts(buildRequest("GET", "/api/invoices/counts"));
    expect(signedOut.status).toBe(401);

    const signedIn = await getCounts(
      buildRequest("GET", "/api/invoices/counts", undefined, { cookie })
    );
    expect(signedIn.status).toBe(200);
    expect((await readJson(signedIn)).counts).toEqual({
      draft: 1,
      sent: 0,
      overdue: 0,
      paid: 0,
      credited: 0,
    });
  });
});

describe("listInvoices filters status before applying a small limit", () => {
  it("returns an old overdue invoice even though two newer ones are not overdue", async () => {
    await makeRow({ number: 2, status: "sent", dueDate: utcMidnight(365) });
    await makeRow({ number: 3, status: "sent", dueDate: utcMidnight(365) });
    const overdue = await prisma.salesInvoice.create({
      data: {
        userId: user.id,
        customerId,
        number: 1,
        reference: nextReference(),
        issueDate: new Date(Date.UTC(2019, 0, 1)),
        dueDate: new Date(Date.UTC(2019, 1, 1)),
        status: "sent",
        documentKind: "invoice",
        grossCents: 2500,
        netCents: 2000,
        vatCents: 500,
      },
    });

    const result = await listInvoices(user.id, { status: "overdue", limit: 2 });
    expect(result.invoices.map((invoice) => invoice.id)).toEqual([overdue.id]);
  });
});
