import { beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import {
  GET as listTemplates,
  POST as createTemplate,
} from "@/app/api/recurring-purchases/route";
import {
  DELETE as deleteTemplate,
  GET as getTemplate,
  PATCH as patchTemplate,
} from "@/app/api/recurring-purchases/[id]/route";
import { POST as runTemplate } from "@/app/api/recurring-purchases/[id]/run/route";
import {
  GET as listPurchases,
  POST as createPurchase,
} from "@/app/api/purchase-invoices/route";
import { GET as getPurchase } from "@/app/api/purchase-invoices/[id]/route";
import { GET as cron } from "@/app/api/cron/recurring-invoices/route";
import { runRecurringPurchases } from "@/lib/recurring-purchases";
import { createReferenceNumber } from "@/lib/finnish-reference";
import { helsinkiCalendarDate } from "@/lib/validation";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import {
  buildRequest,
  readJson,
  routeContext,
  sessionCookie,
  type JsonValue,
} from "./helpers/http";

let user: TestUser;
let cookie: string;
let otherUser: TestUser;
let otherCookie: string;

const REFERENCE = createReferenceNumber("4242");

/** A schedule far in the future: creating it never makes an invoice by itself. */
const FUTURE = {
  supplierName: "Kiinteistö Oy Vuokra",
  supplierBusinessId: null,
  supplierIban: null,
  reference: REFERENCE,
  category: "vuokra",
  notes: "Toimitilan vuokra",
  grossAmount: 1000,
  vatRate: 25.5,
  interval: "monthly",
  dayOfMonth: 15,
  dueDays: 14,
  startDate: "2031-01-01",
};

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function at(day: string): Date {
  return new Date(`${day}T10:00:00Z`);
}

async function postTemplate(
  body: Record<string, unknown> = {},
  auth = cookie,
  headers: Record<string, string> = {},
) {
  return createTemplate(
    buildRequest(
      "POST",
      "/api/recurring-purchases",
      { ...FUTURE, ...body },
      { cookie: auth, headers },
    ),
  );
}

async function makeTemplate(body: Record<string, unknown> = {}) {
  const response = await postTemplate(body);
  const json = await readJson(response);
  expect(response.status, JSON.stringify(json)).toBe(201);
  return json.recurring;
}

async function patch(id: string, body: Record<string, unknown>, auth = cookie) {
  return patchTemplate(
    buildRequest("PATCH", `/api/recurring-purchases/${id}`, body, {
      cookie: auth,
    }),
    routeContext({ id }),
  );
}

async function runNow(id: string, auth = cookie) {
  return runTemplate(
    buildRequest(
      "POST",
      `/api/recurring-purchases/${id}/run`,
      {},
      { cookie: auth },
    ),
    routeContext({ id }),
  );
}

async function list(auth = cookie): Promise<JsonValue[]> {
  const response = await listTemplates(
    buildRequest("GET", "/api/recurring-purchases", undefined, {
      cookie: auth,
    }),
  );
  expect(response.status).toBe(200);
  return (await readJson(response)).recurring;
}

async function invoicesOf(recurringPurchaseId?: string) {
  return prisma.purchaseInvoice.findMany({
    where: recurringPurchaseId ? { recurringPurchaseId } : { userId: user.id },
    orderBy: { issueDate: "asc" },
  });
}

const iso = (date: Date) => date.toISOString().slice(0, 10);

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  otherUser = await createUser();
  otherCookie = await sessionCookie(otherUser);
});

describe("POST /api/recurring-purchases", () => {
  it("stores the template and GET shows the same view", async () => {
    const recurring = await makeTemplate();
    expect(recurring).toEqual({
      id: expect.any(String),
      supplierName: "Kiinteistö Oy Vuokra",
      supplierBusinessId: null,
      supplierIban: null,
      reference: REFERENCE,
      category: "vuokra",
      notes: "Toimitilan vuokra",
      grossAmount: 1000,
      vatRate: 25.5,
      // 1000 * 25.5 / 125.5 = 203.187... -> 203.19, exactly as a purchase invoice derives it.
      netAmount: 796.81,
      vatAmount: 203.19,
      interval: "monthly",
      dayOfMonth: 15,
      dueDays: 14,
      startDate: "2031-01-01",
      endDate: null,
      active: true,
      nextRunDate: "2031-01-15",
      lastRunAt: null,
      runCount: 0,
      lastInvoice: null,
    });
    expect(await invoicesOf()).toHaveLength(0);

    const all = await list();
    expect(all).toEqual([recurring]);
    expect(await list(otherCookie)).toEqual([]);
  });

  it("creates the first invoice at once when the start is today", async () => {
    const today = helsinkiCalendarDate();
    const day = Math.min(Number(today.slice(8, 10)), 28);
    const startDate = `${today.slice(0, 8)}${String(day).padStart(2, "0")}`;
    const recurring = await makeTemplate({
      startDate,
      dayOfMonth: day,
      dueDays: 10,
    });

    expect(recurring.runCount).toBe(1);
    expect(recurring.lastRunAt).toEqual(expect.any(String));
    expect(recurring.lastInvoice).toMatchObject({
      issueDate: startDate,
      dueDate: addDays(startDate, 10),
      status: "open",
      grossAmount: 1000,
    });
    expect(recurring.nextRunDate > today).toBe(true);
    expect(recurring.nextRunDate.slice(0, 7)).not.toBe(startDate.slice(0, 7));

    const invoices = await invoicesOf(recurring.id);
    expect(invoices).toHaveLength(1);
    expect(invoices[0].id).toBe(recurring.lastInvoice.id);

    // "Luo nyt" for the same period makes nothing more.
    const again = await runNow(recurring.id);
    expect(again.status).toBe(200);
    expect(await readJson(again)).toEqual({ created: false });
    expect(await invoicesOf(recurring.id)).toHaveLength(1);
  });

  it("marks fromPurchaseInvoiceId as the period's run instead of creating it again", async () => {
    const today = helsinkiCalendarDate();
    const day = Math.min(Number(today.slice(8, 10)), 28);
    const startDate = `${today.slice(0, 8)}${String(day).padStart(2, "0")}`;
    const created = await createPurchase(
      buildRequest(
        "POST",
        "/api/purchase-invoices",
        {
          supplierName: "Kiinteistö Oy Vuokra",
          issueDate: startDate,
          dueDate: addDays(startDate, 14),
          gross: 1000,
          vat: 203.19,
        },
        { cookie },
      ),
    );
    expect(created.status).toBe(201);
    const source = (await readJson(created)).invoice;

    const recurring = await makeTemplate({
      startDate,
      dayOfMonth: day,
      fromPurchaseInvoiceId: source.id,
    });
    expect(recurring.runCount).toBe(1);
    expect(recurring.lastInvoice).toMatchObject({
      id: source.id,
      issueDate: startDate,
    });
    expect(recurring.nextRunDate > today).toBe(true);

    const invoices = await invoicesOf();
    expect(invoices).toHaveLength(1);
    expect(invoices[0].recurringPurchaseId).toBe(recurring.id);
  });

  it("refuses another owner's fromPurchaseInvoiceId", async () => {
    const created = await createPurchase(
      buildRequest(
        "POST",
        "/api/purchase-invoices",
        {
          supplierName: "Toisen",
          issueDate: "2026-09-01",
          dueDate: "2026-09-15",
          gross: 10,
        },
        { cookie: otherCookie },
      ),
    );
    const foreign = (await readJson(created)).invoice;
    const response = await postTemplate({ fromPurchaseInvoiceId: foreign.id });
    expect(response.status).toBe(404);
    expect(await prisma.recurringPurchase.count()).toBe(0);
  });

  it("answers a retried create with the same template", async () => {
    const first = await postTemplate({}, cookie, {
      "idempotency-key": "toistuva-1",
    });
    const second = await postTemplate({}, cookie, {
      "idempotency-key": "toistuva-1",
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((await readJson(second)).recurring.id).toBe(
      (await readJson(first)).recurring.id,
    );
    expect(await prisma.recurringPurchase.count()).toBe(1);
  });

  it("refuses bad input with Finnish messages", async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ supplierName: "  " }, /Toimittaja/],
      [{ grossAmount: 0 }, /positiivinen/],
      [{ grossAmount: -5 }, /positiivinen/],
      [{ vatRate: 24 }, /ALV-kanta/],
      [{ interval: "weekly" }, /Toistoväli/],
      [{ dayOfMonth: 0 }, /1.28/],
      [{ dayOfMonth: 29 }, /1.28/],
      [{ dayOfMonth: 2.5 }, /1.28/],
      [{ dueDays: -1 }, /0.90/],
      [{ dueDays: 91 }, /0.90/],
      [{ startDate: "2031-02-30" }, /Virheellinen päivä/],
      [{ endDate: "2030-12-31" }, /Päättymispäivä/],
      [{ reference: "1234562" }, /Viitenumero/],
      [{ supplierIban: "FI2112345600000786" }, /IBAN/],
    ];
    for (const [body, message] of cases) {
      const response = await postTemplate(body);
      const json = await readJson(response);
      expect(response.status, JSON.stringify(body)).toBe(400);
      const text = [
        json.error.message,
        ...(json.error.details ?? []).map((d: JsonValue) => d.message),
      ].join(" ");
      expect(text, JSON.stringify(body)).toMatch(message);
    }
    expect(await prisma.recurringPurchase.count()).toBe(0);
  });

  it("requires a session and blocks cross-site posts", async () => {
    const anonymous = await createTemplate(
      buildRequest("POST", "/api/recurring-purchases", FUTURE),
    );
    expect(anonymous.status).toBe(401);
    const crossSite = await createTemplate(
      buildRequest("POST", "/api/recurring-purchases", FUTURE, {
        cookie,
        secFetchSite: "cross-site",
      }),
    );
    expect(crossSite.status).toBe(403);
  });
});

describe("the due run", () => {
  it("creates the invoice of each period and advances nextRunDate monthly", async () => {
    const recurring = await makeTemplate();

    const first = await runRecurringPurchases(user.id, {
      now: at("2031-01-20"),
    });
    expect(first.created).toHaveLength(1);
    expect(first.created[0]).toMatchObject({
      recurringPurchaseId: recurring.id,
      periodKey: "2031-01",
      issueDate: "2031-01-15",
    });

    const [invoice] = await invoicesOf(recurring.id);
    expect(invoice).toMatchObject({
      userId: user.id,
      supplierName: "Kiinteistö Oy Vuokra",
      reference: REFERENCE,
      category: "vuokra",
      notes: "Toimitilan vuokra",
      grossCents: 100_000,
      vatCents: 20_319,
      netCents: 79_681,
      status: "open",
      recurringPurchaseId: recurring.id,
    });
    expect(iso(invoice.issueDate)).toBe("2031-01-15");
    expect(iso(invoice.dueDate)).toBe("2031-01-29");

    let row = await prisma.recurringPurchase.findUniqueOrThrow({
      where: { id: recurring.id },
    });
    expect(iso(row.nextRunDate)).toBe("2031-02-15");
    expect(row.lastRunAt).not.toBeNull();

    // Twice in the same period: still one invoice.
    const repeat = await runRecurringPurchases(user.id, {
      now: at("2031-01-25"),
    });
    expect(repeat.created).toHaveLength(0);
    expect(await invoicesOf(recurring.id)).toHaveLength(1);

    // February: the due date crosses into March.
    await runRecurringPurchases(user.id, { now: at("2031-02-15") });
    const invoices = await invoicesOf(recurring.id);
    expect(invoices.map((entry) => iso(entry.issueDate))).toEqual([
      "2031-01-15",
      "2031-02-15",
    ]);
    expect(iso(invoices[1].dueDate)).toBe("2031-03-01");
    row = await prisma.recurringPurchase.findUniqueOrThrow({
      where: { id: recurring.id },
    });
    expect(iso(row.nextRunDate)).toBe("2031-03-15");

    const runs = await prisma.recurringPurchaseRun.findMany({
      orderBy: { periodKey: "asc" },
    });
    expect(runs.map((run) => run.periodKey)).toEqual(["2031-01", "2031-02"]);
    expect(runs.map((run) => run.purchaseInvoiceId)).toEqual(
      invoices.map((entry) => entry.id),
    );
  });

  it("never creates one period twice, even when the run row is the only guard", async () => {
    const recurring = await makeTemplate();
    await runRecurringPurchases(user.id, { now: at("2031-01-20") });
    // Put the schedule back as if the advance had been lost.
    await prisma.recurringPurchase.update({
      where: { id: recurring.id },
      data: { nextRunDate: new Date("2031-01-15T00:00:00Z") },
    });
    const result = await runRecurringPurchases(user.id, {
      now: at("2031-01-20"),
    });
    expect(result.created).toHaveLength(0);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        periodKey: "2031-01",
        reason: "already_created",
      }),
    ]);
    expect(await invoicesOf(recurring.id)).toHaveLength(1);
  });

  it("advances quarterly and yearly schedules by their interval", async () => {
    const quarterly = await makeTemplate({
      interval: "quarterly",
      dayOfMonth: 10,
      dueDays: 0,
    });
    const yearly = await makeTemplate({
      interval: "yearly",
      dayOfMonth: 28,
      dueDays: 30,
      vatRate: 0,
    });
    expect(quarterly.nextRunDate).toBe("2031-01-10");
    expect(yearly.nextRunDate).toBe("2031-01-28");

    await runRecurringPurchases(user.id, { now: at("2031-01-31") });

    const q = await prisma.recurringPurchase.findUniqueOrThrow({
      where: { id: quarterly.id },
    });
    const y = await prisma.recurringPurchase.findUniqueOrThrow({
      where: { id: yearly.id },
    });
    expect(iso(q.nextRunDate)).toBe("2031-04-10");
    expect(iso(y.nextRunDate)).toBe("2032-01-28");

    const [qInvoice] = await invoicesOf(quarterly.id);
    expect(iso(qInvoice.issueDate)).toBe("2031-01-10");
    expect(iso(qInvoice.dueDate)).toBe("2031-01-10");
    const [yInvoice] = await invoicesOf(yearly.id);
    expect(iso(yInvoice.dueDate)).toBe("2031-02-27");
    expect(yInvoice).toMatchObject({
      grossCents: 100_000,
      vatCents: 0,
      netCents: 100_000,
    });

    await runRecurringPurchases(user.id, { now: at("2031-04-10") });
    expect(
      (await invoicesOf(quarterly.id)).map((entry) => iso(entry.issueDate)),
    ).toEqual(["2031-01-10", "2031-04-10"]);
    expect(await invoicesOf(yearly.id)).toHaveLength(1);
  });

  it("stops at endDate", async () => {
    const recurring = await makeTemplate({
      dayOfMonth: 1,
      endDate: "2031-02-15",
    });
    await runRecurringPurchases(user.id, { now: at("2031-04-02") });
    expect(
      (await invoicesOf(recurring.id)).map((entry) => iso(entry.issueDate)),
    ).toEqual(["2031-01-01", "2031-02-01"]);
    await runRecurringPurchases(user.id, { now: at("2031-06-02") });
    expect(await invoicesOf(recurring.id)).toHaveLength(2);
  });

  it("skips an inactive template", async () => {
    const recurring = await makeTemplate();
    const paused = await patch(recurring.id, { active: false });
    expect(paused.status).toBe(200);
    const result = await runRecurringPurchases(user.id, {
      now: at("2031-02-20"),
    });
    expect(result.created).toHaveLength(0);
    expect(await invoicesOf()).toHaveLength(0);
  });

  it("skips and reports a locked period instead of creating it", async () => {
    const recurring = await makeTemplate();
    await prisma.user.update({
      where: { id: user.id },
      data: { booksLockedThrough: "2031-01" },
    });

    const result = await runRecurringPurchases(user.id, {
      now: at("2031-02-20"),
    });
    expect(result.skipped).toEqual([
      expect.objectContaining({
        recurringPurchaseId: recurring.id,
        periodKey: "2031-01",
        issueDate: "2031-01-15",
        reason: "period_locked",
      }),
    ]);
    expect(result.created.map((entry) => entry.periodKey)).toEqual(["2031-02"]);
    expect(
      (await invoicesOf(recurring.id)).map((entry) => iso(entry.issueDate)),
    ).toEqual(["2031-02-15"]);
    const row = await prisma.recurringPurchase.findUniqueOrThrow({
      where: { id: recurring.id },
    });
    expect(iso(row.nextRunDate)).toBe("2031-03-15");
  });

  it("catches up at most three periods", async () => {
    const recurring = await makeTemplate({ dayOfMonth: 5 });
    const result = await runRecurringPurchases(user.id, {
      now: at("2031-06-10"),
    });
    expect(result.created.map((entry) => entry.issueDate)).toEqual([
      "2031-04-05",
      "2031-05-05",
      "2031-06-05",
    ]);
    expect(
      result.skipped.map((entry) => [entry.periodKey, entry.reason]),
    ).toEqual([
      ["2031-01", "too_old"],
      ["2031-02", "too_old"],
      ["2031-03", "too_old"],
    ]);
    expect(await invoicesOf(recurring.id)).toHaveLength(3);
    const row = await prisma.recurringPurchase.findUniqueOrThrow({
      where: { id: recurring.id },
    });
    expect(iso(row.nextRunDate)).toBe("2031-07-05");
  });

  it("runs from the cron route for every owner", async () => {
    const recurring = await makeTemplate();
    const today = helsinkiCalendarDate();
    await prisma.recurringPurchase.update({
      where: { id: recurring.id },
      data: { nextRunDate: new Date(`${today}T00:00:00Z`) },
    });
    const response = await cron(
      new NextRequest("http://localhost/api/cron/recurring-invoices"),
    );
    const body = await readJson(response);
    expect(body.purchases).toMatchObject({ created: 1, skipped: 0 });
    const invoices = await invoicesOf(recurring.id);
    expect(invoices).toHaveLength(1);
    expect(iso(invoices[0].issueDate)).toBe(today);
  });
});

describe("PATCH, DELETE and run on /api/recurring-purchases/:id", () => {
  it("updates fields and recomputes the schedule", async () => {
    const recurring = await makeTemplate();
    const response = await patch(recurring.id, {
      grossAmount: 500,
      vatRate: 14,
      dayOfMonth: 20,
      supplierName: "Uusi Vuokranantaja Oy",
      category: null,
    });
    expect(response.status).toBe(200);
    const updated = (await readJson(response)).recurring;
    expect(updated).toMatchObject({
      id: recurring.id,
      supplierName: "Uusi Vuokranantaja Oy",
      grossAmount: 500,
      vatRate: 14,
      vatAmount: 61.4,
      netAmount: 438.6,
      dayOfMonth: 20,
      category: null,
      nextRunDate: "2031-01-20",
    });

    expect((await patch(recurring.id, { dayOfMonth: 31 })).status).toBe(400);
    expect((await patch(recurring.id, { vatRate: 7 })).status).toBe(400);
    expect((await patch(recurring.id, {})).status).toBe(400);
  });

  it("clears optional fields sent as null", async () => {
    const recurring = await makeTemplate({
      supplierBusinessId: "0112038-9",
      supplierIban: "FI2112345600000785",
      endDate: "2031-12-31",
    });
    expect(recurring).toMatchObject({
      supplierBusinessId: "0112038-9",
      supplierIban: "FI2112345600000785",
    });
    const response = await patch(recurring.id, {
      supplierBusinessId: null,
      supplierIban: null,
      reference: null,
      category: null,
      notes: null,
      endDate: null,
    });
    expect(response.status).toBe(200);
    expect((await readJson(response)).recurring).toMatchObject({
      supplierName: "Kiinteistö Oy Vuokra",
      supplierBusinessId: null,
      supplierIban: null,
      reference: null,
      category: null,
      notes: null,
      endDate: null,
      grossAmount: 1000,
    });
  });

  it("GET /:id returns the view, 404 for another owner", async () => {
    const recurring = await makeTemplate();
    const own = await getTemplate(
      buildRequest(
        "GET",
        `/api/recurring-purchases/${recurring.id}`,
        undefined,
        { cookie },
      ),
      routeContext({ id: recurring.id }),
    );
    expect(own.status).toBe(200);
    expect((await readJson(own)).recurring).toEqual(recurring);
    const foreign = await getTemplate(
      buildRequest(
        "GET",
        `/api/recurring-purchases/${recurring.id}`,
        undefined,
        { cookie: otherCookie },
      ),
      routeContext({ id: recurring.id }),
    );
    expect(foreign.status).toBe(404);
    expect((await readJson(foreign)).error.message).toBe(
      "Toistuvaa ostolaskua ei löytynyt.",
    );
  });

  it("refuses run on a paused template", async () => {
    const recurring = await makeTemplate();
    await patch(recurring.id, { active: false });
    const response = await runNow(recurring.id);
    expect(response.status).toBe(409);
  });

  it("does not create the paused months when a template is resumed", async () => {
    const recurring = await makeTemplate();
    await patch(recurring.id, { active: false });
    await prisma.recurringPurchase.update({
      where: { id: recurring.id },
      data: { nextRunDate: new Date("2026-01-15T00:00:00Z") },
    });
    const resumed = (
      await readJson(await patch(recurring.id, { active: true }))
    ).recurring;
    expect(resumed.active).toBe(true);
    expect(
      resumed.nextRunDate.slice(0, 7) >= helsinkiCalendarDate().slice(0, 7),
    ).toBe(true);
  });

  it("does not repeat a period already created when the day moves", async () => {
    const recurring = await makeTemplate();
    await runRecurringPurchases(user.id, { now: at("2031-01-16") });
    const response = await patch(recurring.id, { dayOfMonth: 25 });
    expect((await readJson(response)).recurring.nextRunDate).toBe("2031-02-25");
  });

  it("deletes the template but keeps its invoices", async () => {
    const recurring = await makeTemplate();
    await runRecurringPurchases(user.id, { now: at("2031-01-16") });
    const response = await deleteTemplate(
      buildRequest(
        "DELETE",
        `/api/recurring-purchases/${recurring.id}`,
        undefined,
        { cookie },
      ),
      routeContext({ id: recurring.id }),
    );
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true });
    expect(await prisma.recurringPurchase.count()).toBe(0);
    const invoices = await invoicesOf();
    expect(invoices).toHaveLength(1);
    expect(invoices[0].recurringPurchaseId).toBeNull();
  });

  it("answers 404 to another owner", async () => {
    const recurring = await makeTemplate();
    expect(
      (await patch(recurring.id, { active: false }, otherCookie)).status,
    ).toBe(404);
    const removed = await deleteTemplate(
      buildRequest(
        "DELETE",
        `/api/recurring-purchases/${recurring.id}`,
        undefined,
        { cookie: otherCookie },
      ),
      routeContext({ id: recurring.id }),
    );
    expect(removed.status).toBe(404);
    expect((await runNow(recurring.id, otherCookie)).status).toBe(404);
    expect(await prisma.recurringPurchase.count()).toBe(1);
    const row = await prisma.recurringPurchase.findUniqueOrThrow({
      where: { id: recurring.id },
    });
    expect(row.active).toBe(true);
  });

  it("run makes nothing for a period that is not here yet", async () => {
    const recurring = await makeTemplate();
    const response = await runNow(recurring.id);
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ created: false });
    expect(await invoicesOf()).toHaveLength(0);
  });

  it("run creates this month's invoice now when it is due later this month", async () => {
    const recurring = await makeTemplate();
    const today = helsinkiCalendarDate();
    const thisMonth = `${today.slice(0, 7)}-28`;
    await prisma.recurringPurchase.update({
      where: { id: recurring.id },
      data: { dayOfMonth: 28, nextRunDate: new Date(`${thisMonth}T00:00:00Z`) },
    });
    const response = await runNow(recurring.id);
    const body = await readJson(response);
    expect(body).toEqual({
      created: true,
      purchaseInvoiceId: expect.any(String),
    });
    const invoice = await prisma.purchaseInvoice.findUniqueOrThrow({
      where: { id: body.purchaseInvoiceId },
    });
    expect(iso(invoice.issueDate)).toBe(thisMonth);
    expect(invoice.recurringPurchaseId).toBe(recurring.id);

    expect(await readJson(await runNow(recurring.id))).toEqual({
      created: false,
    });
  });
});

describe("purchase invoices show their template", () => {
  it("includes recurringPurchaseId in the list and the detail", async () => {
    const recurring = await makeTemplate();
    await runRecurringPurchases(user.id, { now: at("2031-01-16") });
    const listed = await readJson(
      await listPurchases(
        buildRequest("GET", "/api/purchase-invoices", undefined, { cookie }),
      ),
    );
    expect(listed.invoices).toHaveLength(1);
    expect(listed.invoices[0].recurringPurchaseId).toBe(recurring.id);

    const detail = await readJson(
      await getPurchase(
        buildRequest(
          "GET",
          `/api/purchase-invoices/${listed.invoices[0].id}`,
          undefined,
          { cookie },
        ),
        routeContext({ id: listed.invoices[0].id }),
      ),
    );
    expect(detail.invoice.recurringPurchaseId).toBe(recurring.id);

    const view = (await list())[0];
    expect(view.runCount).toBe(1);
    expect(view.lastInvoice).toEqual({
      id: listed.invoices[0].id,
      issueDate: "2031-01-15",
      dueDate: "2031-01-29",
      status: "open",
      grossAmount: 1000,
    });
  });
});
