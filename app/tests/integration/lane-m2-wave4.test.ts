import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { POST as createRecurring } from "@/app/api/recurring-invoices/route";
import { GET as cron } from "@/app/api/cron/recurring-invoices/route";
import { POST as createCustomer } from "@/app/api/customers/route";
import { POST as createInvoice } from "@/app/api/invoices/route";
import { DELETE as deleteInvoice } from "@/app/api/invoices/[id]/route";
import { GET as invoicePdf } from "@/app/api/invoices/[id]/pdf/route";
import { PUT as setLock } from "@/app/api/period-lock/route";
import { runRecurringInvoices } from "@/lib/recurring-invoices";
import { completeAccountClose } from "@/lib/account-requests";
import { encrypt } from "@/lib/encryption";
import type { EnableBankingClient } from "@/lib/enablebanking/client";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;
let customerId: string;

process.env.MAIL_TRANSPORT = "json";

const LINE = { description: "Ylläpito", quantity: 1, unitPrice: 100, vatRate: 25.5 };

async function makeRecurring(overrides: Record<string, unknown> = {}) {
  const response = await createRecurring(
    buildRequest(
      "POST",
      "/api/recurring-invoices",
      { customerId, interval: "monthly", anchorDay: 5, startDate: "2026-07-05", lines: [LINE], ...overrides },
      { cookie }
    )
  );
  expect(response.status).toBe(201);
  return (await readJson(response)).recurring;
}

function run(now: string, options: Record<string, unknown> = {}) {
  return runRecurringInvoices(user.id, { now: new Date(`${now}T12:00:00Z`), ...options });
}

async function lockThrough(month: string | null) {
  const response = await setLock(buildRequest("PUT", "/api/period-lock", { month, reopen: true }, { cookie }));
  expect(response.status).toBe(200);
}

/** What the real send does to the invoice, without a mail server. */
async function markSent(invoiceId: string) {
  await prisma.salesInvoice.update({ where: { id: invoiceId }, data: { status: "sent", sentAt: new Date() } });
}

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  const response = await createCustomer(
    buildRequest("POST", "/api/customers", { name: "Anna Asiakas", email: "anna@example.fi" }, { cookie })
  );
  customerId = (await readJson(response)).customer.id;
});

describe("a closed account runs no schedules (M2-1)", () => {
  it("closing the account stops the owner's schedules", async () => {
    await makeRecurring();
    const request = await prisma.accountRequest.create({ data: { userId: user.id, kind: "close", status: "pending" } });
    await completeAccountClose(request.id);
    const rows = await prisma.recurringInvoice.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows.every((row) => row.active === false)).toBe(true);
  });

  it("runRecurringInvoices makes nothing for a user whose access is disabled, even with an active schedule", async () => {
    await makeRecurring();
    await prisma.user.update({ where: { id: user.id }, data: { accessDisabledAt: new Date() } });
    const result = await run("2026-09-30");
    expect(result.generated).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(await prisma.salesInvoice.count({ where: { userId: user.id } })).toBe(0);
  });

  it("the cron does not pick up a disabled user's active schedule", async () => {
    await makeRecurring();
    await prisma.user.update({ where: { id: user.id }, data: { accessDisabledAt: new Date() } });
    const body = await readJson(await cron(new NextRequest("http://localhost/api/cron/recurring-invoices")));
    expect(body.users).toBe(0);
    expect(body.generated).toBe(0);
    expect(await prisma.salesInvoice.count({ where: { userId: user.id } })).toBe(0);
  });
});

describe("occurrences recovered from a locked month are not mailed on their own (M2-2)", () => {
  it("are made as drafts, the send is not called, and the run row counts from the recovery", async () => {
    await makeRecurring({ autoSend: true });
    await lockThrough("2026-08");
    const sent: string[] = [];
    const send = async (id: string) => void sent.push(id);
    const first = await run("2026-09-30", { send });
    // Only the open month's occurrence is mailed.
    expect(first.generated.map((entry) => [entry.issueDate, entry.sent])).toEqual([["2026-09-05", true]]);
    expect(sent).toHaveLength(1);

    await lockThrough(null);
    const recoveredAt = new Date("2026-10-02T12:00:00Z");
    const third = await runRecurringInvoices(user.id, { now: recoveredAt, send });
    expect(third.generated.map((entry) => entry.issueDate)).toEqual(["2026-07-05", "2026-08-05"]);
    expect(third.generated.every((entry) => entry.sent === false && entry.sendError === null)).toBe(true);
    expect(sent).toHaveLength(1);

    const drafts = await prisma.salesInvoice.findMany({
      where: { userId: user.id, issueDate: { lt: new Date("2026-09-01T00:00:00Z") } },
    });
    expect(drafts).toHaveLength(2);
    expect(drafts.every((invoice) => invoice.status === "draft")).toBe(true);
    const runs = await prisma.recurringInvoiceRun.findMany({
      where: { issueDate: { lt: new Date("2026-09-01T00:00:00Z") } },
    });
    expect(runs.every((entry) => entry.status === "created" && entry.invoiceId)).toBe(true);
    // The window of any later retry counts from the recovery, not the old row.
    expect(runs.every((entry) => entry.createdAt.getTime() >= recoveredAt.getTime())).toBe(true);
  });
});

describe("a retry never mails an invoice another run already sent (M2-3)", () => {
  it("skips a row that was sent by an overlapping run after this one loaded it", async () => {
    await makeRecurring({ autoSend: true, startDate: "2026-08-05", anchorDay: 5 });
    // Two occurrences whose automatic mail failed.
    await run("2026-09-30", {
      send: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:587");
      },
    });
    const failed = await prisma.recurringInvoiceRun.findMany({ orderBy: { issueDate: "asc" } });
    expect(failed.map((entry) => entry.status)).toEqual(["created_send_failed", "created_send_failed"]);

    // The real send holds a per-invoice lock, so a second mail for an invoice
    // that is being sent right now is refused; one for an invoice that was
    // already sent is not, and that is the case this guards.
    const inflight = new Set<string>();
    const delivered: string[] = [];
    const deliver = async (id: string, wait?: Promise<void>) => {
      if (inflight.has(id)) throw new Error("Laskua lähetetään juuri nyt.");
      inflight.add(id);
      try {
        if (wait) await wait;
        await markSent(id);
        delivered.push(id);
      } finally {
        inflight.delete(id);
      }
    };
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    // Run B has loaded both rows and is stuck inside the first mail.
    const runB = run("2026-10-01", {
      send: async (id: string) => {
        const wait = first ? gate : undefined;
        first = false;
        await deliver(id, wait);
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    // Run A (a manual "run now") sends what it can meanwhile.
    await run("2026-10-01", { send: (id: string) => deliver(id) });
    release();
    await runB;

    expect(delivered).toHaveLength(2);
    expect(new Set(delivered).size).toBe(2);
  });
});

describe("closing an account ends the bank consent at the bank (M2-5)", () => {
  async function seedConnection(name: string, extra: Record<string, unknown> = {}) {
    return prisma.bankConnection.create({
      data: {
        userId: user.id,
        aspspName: name,
        aspspCountry: "FI",
        psuType: "business",
        status: "active",
        sessionIdEnc: encrypt(`session-${name}`),
        authStateHash: "hash",
        lastError: "Pankin lupa vanheni.",
        ...extra,
      },
    });
  }

  it("deletes each session at the bank, clears lastError and notes nothing when all went well", async () => {
    await seedConnection("Pankki A");
    const deleted: string[] = [];
    const client = {
      deleteSession: async (id: string) => void deleted.push(id),
    } as unknown as EnableBankingClient;
    const request = await prisma.accountRequest.create({ data: { userId: user.id, kind: "close", status: "pending" } });
    const done = await completeAccountClose(request.id, { bankClient: client });

    expect(deleted).toEqual(["session-Pankki A"]);
    const connection = await prisma.bankConnection.findFirstOrThrow({ where: { userId: user.id } });
    expect(connection).toMatchObject({ status: "revoked", sessionIdEnc: null, lastError: null });
    expect(done.note ?? "").not.toMatch(/Pankki A/);
  });

  it("still closes when the bank does not answer, and records which consent is left to end by itself", async () => {
    await seedConnection("Pankki A");
    await seedConnection("Pankki B");
    const client = {
      deleteSession: async (id: string) => {
        if (id === "session-Pankki B") throw new Error("ECONNRESET");
      },
    } as unknown as EnableBankingClient;
    const request = await prisma.accountRequest.create({ data: { userId: user.id, kind: "close", status: "pending" } });
    const done = await completeAccountClose(request.id, { bankClient: client });

    expect(done.status).toBe("completed");
    const rows = await prisma.bankConnection.findMany({ where: { userId: user.id } });
    expect(rows.every((row) => row.status === "revoked" && row.sessionIdEnc === null && row.lastError === null)).toBe(true);
    expect(done.note).toMatch(/Pankki B/);
    expect(done.note).not.toMatch(/Pankki A/);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).accessDisabledAt).not.toBeNull();
  });
});

describe("a draft whose PDF was shared keeps its number (M2-4)", () => {
  const INVOICE_LINE = { description: "Ripsienpidennys", quantity: 1, unitPrice: 100, vatRate: 25.5 };

  async function makeInvoice() {
    const response = await createInvoice(
      buildRequest(
        "POST",
        "/api/invoices",
        { customerId, issueDate: "2026-01-15", dueDate: "2026-01-29", lines: [INVOICE_LINE] },
        { cookie }
      )
    );
    expect(response.status).toBe(201);
    return (await readJson(response)).invoice;
  }

  async function openPdf(id: string) {
    const response = await invoicePdf(
      buildRequest("GET", `/api/invoices/${id}/pdf`, undefined, { cookie }),
      routeContext({ id })
    );
    expect(response.status).toBe(200);
    return response;
  }

  async function remove(id: string) {
    const response = await deleteInvoice(
      buildRequest("DELETE", `/api/invoices/${id}`, undefined, { cookie }),
      routeContext({ id })
    );
    expect(response.status).toBe(200);
  }

  it("serving the PDF of a draft records it once, and deleting the draft does not give the number back", async () => {
    const draft = await makeInvoice();
    await openPdf(draft.id);
    await openPdf(draft.id);
    const shared = await prisma.invoiceActivity.findMany({ where: { invoiceId: draft.id, kind: "shared" } });
    expect(shared).toHaveLength(1);

    await remove(draft.id);
    const next = await makeInvoice();
    expect(next.number).not.toBe(draft.number);
    expect(next.reference).not.toBe(draft.reference);
  });

  it("a draft that nobody opened still gives its number back", async () => {
    const draft = await makeInvoice();
    await remove(draft.id);
    const next = await makeInvoice();
    expect(next.number).toBe(draft.number);
  });

  it("an issued invoice's PDF leaves no shared record", async () => {
    const invoice = await makeInvoice();
    await prisma.salesInvoice.update({ where: { id: invoice.id }, data: { status: "sent", sentAt: new Date() } });
    await openPdf(invoice.id);
    expect(await prisma.invoiceActivity.count({ where: { invoiceId: invoice.id, kind: "shared" } })).toBe(0);
  });
});
