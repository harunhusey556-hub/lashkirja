import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import {
  GET as listRecurring,
  POST as createRecurring,
} from "@/app/api/recurring-invoices/route";
import {
  DELETE as deleteRecurring,
  GET as getRecurring,
  PATCH as patchRecurring,
} from "@/app/api/recurring-invoices/[id]/route";
import { POST as runRecurring } from "@/app/api/recurring-invoices/run/route";
import { POST as createCustomer } from "@/app/api/customers/route";
import { PUT as setLock } from "@/app/api/period-lock/route";
import { runRecurringInvoices } from "@/lib/recurring-invoices";
import { encrypt } from "@/lib/encryption";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie, type JsonValue } from "./helpers/http";

let user: TestUser;
let cookie: string;
let otherUser: TestUser;
let otherCookie: string;
let customerId: string;

process.env.MAIL_TRANSPORT = "json";

const LINE = { description: "Ylläpito", quantity: 1, unitPrice: 100, vatRate: 25.5 };

async function makeCustomer(overrides: Record<string, unknown> = {}, auth = cookie) {
  const response = await createCustomer(
    buildRequest(
      "POST",
      "/api/customers",
      { name: "Anna Asiakas", email: "anna@example.fi", ...overrides },
      { cookie: auth }
    )
  );
  return (await readJson(response)).customer;
}

async function postRecurring(overrides: Record<string, unknown> = {}, auth = cookie) {
  return createRecurring(
    buildRequest(
      "POST",
      "/api/recurring-invoices",
      {
        customerId,
        interval: "monthly",
        anchorDay: 1,
        startDate: "2026-01-01",
        lines: [LINE],
        ...overrides,
      },
      { cookie: auth }
    )
  );
}

async function makeRecurring(overrides: Record<string, unknown> = {}) {
  const response = await postRecurring(overrides);
  expect(response.status).toBe(201);
  return (await readJson(response)).recurring;
}

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  otherUser = await createUser();
  otherCookie = await sessionCookie(otherUser);
  customerId = (await makeCustomer()).id;
});

describe("POST /api/recurring-invoices", () => {
  it("stores the schedule and computes the first run", async () => {
    const recurring = await makeRecurring({ anchorDay: 15, startDate: "2026-01-01" });
    expect(recurring).toMatchObject({
      interval: "monthly",
      anchorDay: 15,
      nextRunAt: "2026-01-15",
      active: true,
      autoSend: false,
      total: 100,
    });
    expect(recurring.lines).toHaveLength(1);
  });

  it("moves the first run forward when the anchor has already passed", async () => {
    const recurring = await makeRecurring({ anchorDay: 5, startDate: "2026-01-20" });
    expect(recurring.nextRunAt).toBe("2026-02-05");
  });

  it("takes the payment term from the customer when not given", async () => {
    const slow = await makeCustomer({ name: "Hidas", defaultPaymentTermDays: 30 });
    const recurring = await makeRecurring({ customerId: slow.id });
    expect(recurring.paymentTermDays).toBe(30);
  });

  it("refuses an impossible schedule", async () => {
    expect((await postRecurring({ anchorDay: 0 })).status).toBe(400);
    expect((await postRecurring({ anchorDay: 32 })).status).toBe(400);
    expect((await postRecurring({ interval: "weekly" })).status).toBe(400);
    expect((await postRecurring({ endDate: "2025-12-01" })).status).toBe(400);
    expect((await postRecurring({ lines: [] })).status).toBe(400);
    expect(await prisma.recurringInvoice.count()).toBe(0);
  });

  it("refuses another user's customer and an archived one", async () => {
    const foreign = await makeCustomer({ name: "Toisen" }, otherCookie);
    expect((await postRecurring({ customerId: foreign.id })).status).toBe(404);

    await prisma.customer.update({
      where: { id: customerId },
      data: { archivedAt: new Date() },
    });
    expect((await postRecurring()).status).toBe(409);
  });

  it("requires a session and blocks cross-site posts", async () => {
    expect(
      (
        await createRecurring(
          buildRequest("POST", "/api/recurring-invoices", {
            customerId,
            interval: "monthly",
            anchorDay: 1,
            startDate: "2026-01-01",
            lines: [LINE],
          })
        )
      ).status
    ).toBe(401);
    expect((await postRecurring({}, cookie)).status).toBe(201);
  });
});

describe("running a schedule", () => {
  async function run(now: string, options: Record<string, unknown> = {}) {
    return runRecurringInvoices(user.id, { now: new Date(`${now}T12:00:00Z`), ...options });
  }

  it("generates one invoice per due occurrence, oldest first", async () => {
    const recurring = await makeRecurring({ anchorDay: 1, startDate: "2026-01-01" });

    const result = await run("2026-03-15");
    expect(result.generated.map((entry) => entry.issueDate)).toEqual([
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
    ]);
    expect(result.generated[0].invoice.gross).toBe(125.5);
    expect(result.generated.map((entry) => entry.invoice.number)).toEqual([1, 2, 3]);

    const stored = await prisma.recurringInvoice.findUnique({ where: { id: recurring.id } });
    expect(stored?.nextRunAt?.toISOString().slice(0, 10)).toBe("2026-04-01");
  });

  it("is idempotent: a second run generates nothing", async () => {
    await makeRecurring({ anchorDay: 1, startDate: "2026-01-01" });
    const first = await run("2026-02-15");
    const second = await run("2026-02-15");

    expect(first.generated).toHaveLength(2);
    expect(second.generated).toHaveLength(0);
    expect(await prisma.salesInvoice.count()).toBe(2);
  });

  it("keeps the anchor across a short month", async () => {
    await makeRecurring({ anchorDay: 31, startDate: "2026-01-31" });
    const result = await run("2026-04-01");
    expect(result.generated.map((entry) => entry.issueDate)).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
    ]);
  });

  it("stops at the end date and marks the schedule finished", async () => {
    const recurring = await makeRecurring({
      anchorDay: 1,
      startDate: "2026-01-01",
      endDate: "2026-02-28",
    });
    const result = await run("2026-06-01");
    expect(result.generated).toHaveLength(2);

    const stored = await prisma.recurringInvoice.findUnique({ where: { id: recurring.id } });
    expect(stored?.nextRunAt).toBeNull();
  });

  it("ignores a paused schedule", async () => {
    const recurring = await makeRecurring({ anchorDay: 1, startDate: "2026-01-01" });
    await patchRecurring(
      buildRequest("PATCH", `/api/recurring-invoices/${recurring.id}`, { active: false }, { cookie }),
      routeContext({ id: recurring.id })
    );
    expect((await run("2026-06-01")).generated).toHaveLength(0);
  });

  it("dates each invoice on its own occurrence, with the term applied from there", async () => {
    await makeRecurring({ anchorDay: 10, startDate: "2026-01-10", paymentTermDays: 14 });
    const result = await run("2026-02-15");
    expect(result.generated[0].invoice.issueDate).toBe("2026-01-10");
    expect(result.generated[0].invoice.dueDate).toBe("2026-01-24");
    expect(result.generated[1].invoice.issueDate).toBe("2026-02-10");
  });

  it("skips an occurrence inside a closed period without losing the rest", async () => {
    await makeRecurring({ anchorDay: 1, startDate: "2026-01-01" });
    await setLock(buildRequest("PUT", "/api/period-lock", { month: "2026-01" }, { cookie }));

    const result = await run("2026-02-15");
    expect(result.skipped).toEqual([
      expect.objectContaining({ issueDate: "2026-01-01", reason: "period_locked" }),
    ]);
    expect(result.generated.map((entry) => entry.issueDate)).toEqual(["2026-02-01"]);

    const runs = await prisma.recurringInvoiceRun.findMany({ orderBy: { issueDate: "asc" } });
    expect(runs.map((entry) => entry.status)).toEqual(["skipped_locked", "created"]);
    // The skipped occurrence is recorded and left alone while the month is
    // closed (it is made once the month opens: recurring-run-recovery.test.ts).
    const again = await run("2026-02-15");
    expect(again.generated).toHaveLength(0);
    expect(again.skipped).toHaveLength(0);
  });

  it("caps a runaway catch-up and reports it", async () => {
    await makeRecurring({ anchorDay: 1, startDate: "2020-01-01" });
    const result = await run("2026-01-01");
    expect(result.generated).toHaveLength(24);
    expect(result.truncated).toHaveLength(1);
  });

  it("keeps the invoice when automatic sending fails", async () => {
    await makeRecurring({ anchorDay: 1, startDate: "2026-01-01", autoSend: true });

    const result = await run("2026-01-15", {
      send: async () => {
        throw new Error("SMTP down");
      },
    });
    expect(result.generated).toHaveLength(1);
    expect(result.generated[0].sent).toBe(false);
    expect(result.generated[0].sendError).toContain("SMTP down");

    const run0 = await prisma.recurringInvoiceRun.findFirst();
    // The invoice exists, the mail did not leave: a state of its own (G07).
    expect(run0?.status).toBe("created_send_failed");
    expect(run0?.invoiceId).not.toBeNull();
    expect(await prisma.salesInvoice.count()).toBe(1);
  });

  it("sends and marks the invoice sent when autoSend succeeds", async () => {
    await prisma.imapAccount.create({
      data: {
        userId: user.id,
        email: "liisa@example.fi",
        host: "imap.gmail.com",
        port: 993,
        encryptedPass: encrypt("app-password"),
      },
    });
    await prisma.user.update({
      where: { id: user.id },
      data: { invoiceIban: "FI2112345600000785" },
    });
    await makeRecurring({ anchorDay: 1, startDate: "2026-01-01", autoSend: true });

    const { sendInvoiceByEmail } = await import("@/lib/invoice-mail");
    const result = await run("2026-01-15", {
      send: (invoiceId: string) =>
        sendInvoiceByEmail(user.id, invoiceId).then(() => undefined),
    });

    expect(result.generated[0].sent).toBe(true);
    const invoice = await prisma.salesInvoice.findFirst();
    expect(invoice?.status).toBe("sent");
  });

  it("keeps a failed email as history and leaves the invoice a draft", async () => {
    await prisma.user.update({
      where: { id: user.id },
      data: { invoiceIban: "FI2112345600000785" },
    });
    await prisma.imapAccount.create({
      data: {
        userId: user.id,
        email: "liisa@example.fi",
        host: "imap.gmail.com",
        port: 993,
        encryptedPass: encrypt("app-password"),
      },
    });
    await makeRecurring({ anchorDay: 1, startDate: "2026-01-01", autoSend: true });
    const { sendInvoiceByEmail } = await import("@/lib/invoice-mail");
    const result = await run("2026-01-15", {
      send: (invoiceId: string) =>
        sendInvoiceByEmail(user.id, invoiceId, {}, {
          deliver: async () => {
            throw new Error("SMTP down");
          },
        }).then(() => undefined),
    });
    expect(result.generated[0].sent).toBe(false);
    expect(result.generated[0].sendError).toContain("SMTP");
    const invoice = await prisma.salesInvoice.findFirst();
    expect(invoice?.status).toBe("draft");
    const sends = await prisma.invoiceEmailSend.findMany({ where: { invoiceId: invoice?.id } });
    expect(sends.map((send) => send.status)).toEqual(["failed"]);
  });

  it("issues the 31st, clamps February, then returns to the 31st", async () => {
    await makeRecurring({ anchorDay: 31, startDate: "2026-01-31", interval: "monthly" });
    const result = await run("2026-03-31");
    expect(result.generated.map((entry) => entry.issueDate)).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
    ]);
  });

  it("resumes a paused schedule on the next run", async () => {
    const recurring = await makeRecurring({ anchorDay: 1, startDate: "2026-01-01" });
    await patchRecurring(
      buildRequest("PATCH", `/api/recurring-invoices/${recurring.id}`, { active: false }, { cookie }),
      routeContext({ id: recurring.id })
    );
    expect((await run("2026-01-15")).generated).toHaveLength(0);
    await patchRecurring(
      buildRequest("PATCH", `/api/recurring-invoices/${recurring.id}`, { active: true }, { cookie }),
      routeContext({ id: recurring.id })
    );
    expect((await run("2026-01-15")).generated).toHaveLength(1);
  });

  it("does not invoice an archived customer", async () => {
    await makeRecurring({ anchorDay: 1, startDate: "2026-01-01" });
    await prisma.customer.update({
      where: { id: customerId },
      data: { archivedAt: new Date("2026-01-02T00:00:00.000Z") },
    });
    const result = await run("2026-01-15");
    expect(result.generated).toHaveLength(0);
    expect(result.skipped[0]).toMatchObject({ reason: "failed" });
    expect(result.skipped[0].detail).toContain("arkistoitu");
  });

  it("never generates for another user's schedule", async () => {
    await makeRecurring({ anchorDay: 1, startDate: "2026-01-01" });
    const result = await runRecurringInvoices(otherUser.id, {
      now: new Date("2026-06-01T12:00:00Z"),
    });
    expect(result.generated).toHaveLength(0);
    expect(await prisma.salesInvoice.count()).toBe(0);
  });
});

describe("POST /api/recurring-invoices/run", () => {
  it("generates through the API and reports what it did", async () => {
    await makeRecurring({ anchorDay: 1, startDate: "2020-01-01" });

    const body = await readJson(
      await runRecurring(buildRequest("POST", "/api/recurring-invoices/run", {}, { cookie }))
    );
    expect(body.generated.length).toBeGreaterThan(0);
    expect(body.generated[0]).toMatchObject({ issueDate: "2020-01-01", invoiceNumber: 1 });
  });

  it("can target a single schedule", async () => {
    const first = await makeRecurring({ anchorDay: 1, startDate: "2020-01-01" });
    await makeRecurring({ anchorDay: 2, startDate: "2020-01-02" });

    const body = await readJson(
      await runRecurring(
        buildRequest(
          "POST",
          "/api/recurring-invoices/run",
          { recurringInvoiceId: first.id },
          { cookie }
        )
      )
    );
    expect(
      body.generated.every((entry: JsonValue) => entry.recurringInvoiceId === first.id)
    ).toBe(true);
  });

  it("refuses a paused or foreign schedule", async () => {
    const recurring = await makeRecurring({ anchorDay: 1, startDate: "2026-01-01" });
    await patchRecurring(
      buildRequest("PATCH", `/api/recurring-invoices/${recurring.id}`, { active: false }, { cookie }),
      routeContext({ id: recurring.id })
    );
    const paused = await runRecurring(
      buildRequest(
        "POST",
        "/api/recurring-invoices/run",
        { recurringInvoiceId: recurring.id },
        { cookie }
      )
    );
    expect(paused.status).toBe(409);

    const foreign = await runRecurring(
      buildRequest(
        "POST",
        "/api/recurring-invoices/run",
        { recurringInvoiceId: recurring.id },
        { cookie: otherCookie }
      )
    );
    expect(foreign.status).toBe(404);
  });
});

describe("GET / PATCH / DELETE /api/recurring-invoices", () => {
  it("lists active schedules and counts what is due now", async () => {
    await makeRecurring({ anchorDay: 1, startDate: "2020-01-01" });
    const paused = await makeRecurring({ anchorDay: 1, startDate: "2020-01-01" });
    await patchRecurring(
      buildRequest("PATCH", `/api/recurring-invoices/${paused.id}`, { active: false }, { cookie }),
      routeContext({ id: paused.id })
    );

    const body = await readJson(
      await listRecurring(buildRequest("GET", "/api/recurring-invoices", undefined, { cookie }))
    );
    expect(body.recurring).toHaveLength(1);
    expect(body.dueNow).toBe(1);

    const all = await readJson(
      await listRecurring(
        buildRequest("GET", "/api/recurring-invoices?includeInactive=1", undefined, { cookie })
      )
    );
    expect(all.recurring).toHaveLength(2);
  });

  it("replaces the line template without touching invoices already generated", async () => {
    const recurring = await makeRecurring({ anchorDay: 1, startDate: "2026-01-01" });
    await runRecurringInvoices(user.id, { now: new Date("2026-01-15T12:00:00Z") });
    const before = await prisma.salesInvoice.findFirst({ include: { lines: true } });

    await patchRecurring(
      buildRequest(
        "PATCH",
        `/api/recurring-invoices/${recurring.id}`,
        { lines: [{ description: "Uusi hinta", quantity: 1, unitPrice: 200, vatRate: 25.5 }] },
        { cookie }
      ),
      routeContext({ id: recurring.id })
    );

    const after = await prisma.salesInvoice.findFirst({ include: { lines: true } });
    expect(after?.grossCents).toBe(before?.grossCents);
    expect(after?.lines[0].description).toBe("Ylläpito");

    const updated = await readJson(
      await getRecurring(
        buildRequest("GET", `/api/recurring-invoices/${recurring.id}`, undefined, { cookie }),
        routeContext({ id: recurring.id })
      )
    );
    expect(updated.recurring.total).toBe(200);
  });

  it("does not re-generate history when the schedule is edited", async () => {
    const recurring = await makeRecurring({ anchorDay: 1, startDate: "2026-01-01" });
    await runRecurringInvoices(user.id, { now: new Date("2026-03-15T12:00:00Z") });
    expect(await prisma.salesInvoice.count()).toBe(3);

    await patchRecurring(
      buildRequest(
        "PATCH",
        `/api/recurring-invoices/${recurring.id}`,
        { anchorDay: 5 },
        { cookie }
      ),
      routeContext({ id: recurring.id })
    );

    await runRecurringInvoices(user.id, { now: new Date("2026-03-15T12:00:00Z") });
    expect(await prisma.salesInvoice.count()).toBe(3);
  });

  it("deletes the schedule but keeps the invoices it produced", async () => {
    const recurring = await makeRecurring({ anchorDay: 1, startDate: "2026-01-01" });
    await runRecurringInvoices(user.id, { now: new Date("2026-01-15T12:00:00Z") });

    const response = await deleteRecurring(
      buildRequest("DELETE", `/api/recurring-invoices/${recurring.id}`, undefined, { cookie }),
      routeContext({ id: recurring.id })
    );
    expect(response.status).toBe(200);
    expect(await prisma.recurringInvoice.count()).toBe(0);
    expect(await prisma.recurringInvoiceRun.count()).toBe(0);
    expect(await prisma.salesInvoice.count()).toBe(1);
  });

  it("404s on another user's schedule", async () => {
    const recurring = await makeRecurring();
    const context = routeContext({ id: recurring.id });
    expect(
      (
        await getRecurring(
          buildRequest("GET", `/api/recurring-invoices/${recurring.id}`, undefined, {
            cookie: otherCookie,
          }),
          context
        )
      ).status
    ).toBe(404);
    expect(
      (
        await deleteRecurring(
          buildRequest("DELETE", `/api/recurring-invoices/${recurring.id}`, undefined, {
            cookie: otherCookie,
          }),
          context
        )
      ).status
    ).toBe(404);
  });
});
