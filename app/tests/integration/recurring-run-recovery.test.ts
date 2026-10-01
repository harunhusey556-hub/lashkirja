import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { GET as listRecurring, POST as createRecurring } from "@/app/api/recurring-invoices/route";
import { GET as previewRun, POST as runRecurring } from "@/app/api/recurring-invoices/run/route";
import { GET as cron } from "@/app/api/cron/recurring-invoices/route";
import { POST as createCustomer } from "@/app/api/customers/route";
import { PUT as setLock } from "@/app/api/period-lock/route";
import { countDueRecurringInvoices, runRecurringInvoices } from "@/lib/recurring-invoices";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

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
      {
        customerId,
        interval: "monthly",
        anchorDay: 5,
        startDate: "2026-07-05",
        lines: [LINE],
        ...overrides,
      },
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
  const response = await setLock(
    buildRequest("PUT", "/api/period-lock", { month, reopen: true }, { cookie })
  );
  expect(response.status).toBe(200);
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

describe("occurrences skipped by a locked month (G05)", () => {
  it("are created by the next run once the month is open, oldest first", async () => {
    await makeRecurring();
    await lockThrough("2026-08");
    const first = await run("2026-09-30");
    expect(first.generated.map((entry) => entry.issueDate)).toEqual(["2026-09-05"]);
    expect(first.skipped.map((entry) => [entry.issueDate, entry.reason])).toEqual([
      ["2026-07-05", "period_locked"],
      ["2026-08-05", "period_locked"],
    ]);

    // Still locked: nothing more is made and nothing is reported twice.
    const second = await run("2026-09-30");
    expect(second.generated).toHaveLength(0);
    expect(second.skipped).toHaveLength(0);

    await lockThrough(null);
    const third = await run("2026-09-30");
    expect(third.generated.map((entry) => entry.issueDate)).toEqual(["2026-07-05", "2026-08-05"]);
    expect(third.skipped).toHaveLength(0);

    const invoices = await prisma.salesInvoice.findMany({ orderBy: { issueDate: "asc" } });
    expect(invoices.map((invoice) => invoice.issueDate.toISOString().slice(0, 10))).toEqual([
      "2026-07-05",
      "2026-08-05",
      "2026-09-05",
    ]);
    const runs = await prisma.recurringInvoiceRun.findMany();
    expect(runs.every((entry) => entry.status === "created" && entry.invoiceId)).toBe(true);
    // And never twice.
    expect((await run("2026-09-30")).generated).toHaveLength(0);
    expect(await prisma.salesInvoice.count()).toBe(3);
  });

  it("count as due on Toistuvat only when the month is open again", async () => {
    await makeRecurring();
    await lockThrough("2026-08");
    await run("2026-09-30");
    expect(await countDueRecurringInvoices(user.id, new Date("2026-09-30T12:00:00Z"))).toBe(0);
    await lockThrough(null);
    expect(await countDueRecurringInvoices(user.id, new Date("2026-09-30T12:00:00Z"))).toBe(1);
  });

  it("generatedCount counts invoices, and the schedule lists what was missed and why", async () => {
    const recurring = await makeRecurring();
    await lockThrough("2026-08");
    await run("2026-09-30");
    const body = await readJson(
      await listRecurring(buildRequest("GET", "/api/recurring-invoices", undefined, { cookie }))
    );
    const entry = body.recurring.find((item: { id: string }) => item.id === recurring.id);
    expect(entry.generatedCount).toBe(1);
    expect(entry.missedRuns.map((missed: { issueDate: string }) => missed.issueDate)).toEqual([
      "2026-07-05",
      "2026-08-05",
    ]);
    expect(entry.missedRuns[0]).toMatchObject({ reason: "period_locked" });
  });

  it("the preview keeps locked dates out of what it promises and names them", async () => {
    await makeRecurring();
    await lockThrough("2026-08");
    const body = await readJson(
      await previewRun(buildRequest("GET", "/api/recurring-invoices/run", undefined, { cookie }))
    );
    const entry = body.plan[0];
    expect(entry.lockedDates).toEqual(["2026-07-05", "2026-08-05"]);
    expect(entry.issueDates).not.toContain("2026-07-05");
    expect(entry.issueDates).not.toContain("2026-08-05");
    expect(entry.issueDates[0]).toBe("2026-09-05");
  });
});

describe("a failed automatic send (G07)", () => {
  async function failingRun(now: string) {
    return run(now, {
      send: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:587");
      },
    });
  }

  it("is a state of its own that the schedule shows, not a plain created run", async () => {
    const recurring = await makeRecurring({ autoSend: true, startDate: "2026-09-30", anchorDay: 30 });
    const result = await failingRun("2026-09-30");
    expect(result.generated[0].sent).toBe(false);
    const stored = await prisma.recurringInvoiceRun.findFirstOrThrow();
    expect(stored.status).toBe("created_send_failed");

    const body = await readJson(
      await listRecurring(buildRequest("GET", "/api/recurring-invoices", undefined, { cookie }))
    );
    const entry = body.recurring.find((item: { id: string }) => item.id === recurring.id);
    expect(entry.failedSends).toEqual([
      expect.objectContaining({ issueDate: "2026-09-30", invoiceId: stored.invoiceId }),
    ]);
  });

  it("is sent by the next run, once the mail works again, and the state clears", async () => {
    await makeRecurring({ autoSend: true, startDate: "2026-09-30", anchorDay: 30 });
    await failingRun("2026-09-30");
    const sent: string[] = [];
    const retry = await run("2026-10-01", {
      send: async (invoiceId: string) => {
        sent.push(invoiceId);
      },
    });
    expect(sent).toHaveLength(1);
    expect(retry.sendRetries).toEqual([expect.objectContaining({ sent: true, sendError: null })]);
    expect((await prisma.recurringInvoiceRun.findFirstOrThrow()).status).toBe("created");
    // Nothing is sent a third time.
    await run("2026-10-02", { send: async (id: string) => void sent.push(id) });
    expect(sent).toHaveLength(1);
  });

  it("does not retry for ever: after two days the invoice waits for a tap", async () => {
    await makeRecurring({ autoSend: true, startDate: "2026-09-30", anchorDay: 30 });
    await failingRun("2026-09-30");
    await prisma.recurringInvoiceRun.updateMany({
      data: { createdAt: new Date("2026-09-20T00:00:00Z") },
    });
    const sent: string[] = [];
    await run("2026-10-02", { send: async (id: string) => void sent.push(id) });
    expect(sent).toHaveLength(0);
  });

  it("makes the cron say so instead of a plain ok", async () => {
    await makeRecurring({ autoSend: true, startDate: "2026-09-30", anchorDay: 30 });
    // No mailbox is connected, so the send inside the cron fails.
    const response = await cron(new NextRequest("http://localhost/api/cron/recurring-invoices"));
    const body = await readJson(response);
    expect(body.generated).toBe(1);
    expect(body.sendFailed).toBe(1);
    expect(body.ok).toBe(false);
    expect(body.sendErrors[0]).toMatchObject({ error: expect.any(String) });
  });
});

describe("the run over HTTP", () => {
  it("still answers for a schedule that is simply due", async () => {
    await makeRecurring({ startDate: "2026-09-05" });
    const response = await runRecurring(
      buildRequest("POST", "/api/recurring-invoices/run", {}, { cookie })
    );
    expect(response.status).toBe(200);
  });
});
