import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { POST as createCustomer } from "@/app/api/customers/route";
import { DELETE as deleteCustomer, GET as getCustomer, PATCH as patchCustomer } from "@/app/api/customers/[id]/route";
import { POST as createRecurring } from "@/app/api/recurring-invoices/route";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;
let customerId: string;

const LINE = { description: "Ylläpito", quantity: 1, unitPrice: 100, vatRate: 25.5 };

async function schedule(overrides: Record<string, unknown> = {}) {
  const response = await createRecurring(
    buildRequest(
      "POST",
      "/api/recurring-invoices",
      {
        customerId,
        interval: "monthly",
        anchorDay: 1,
        startDate: "2030-12-01",
        lines: [LINE],
        ...overrides,
      },
      { cookie }
    )
  );
  expect(response.status).toBe(201);
  return (await readJson(response)).recurring;
}

function remove() {
  return deleteCustomer(
    buildRequest("DELETE", `/api/customers/${customerId}`, undefined, { cookie }),
    routeContext({ id: customerId })
  );
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

describe("a customer with a recurring schedule and no invoices (G21)", () => {
  it("is archived, not refused with a database message, and its schedule is paused", async () => {
    const recurring = await schedule();
    const response = await remove();
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body).toMatchObject({ deleted: false, archived: true, invoiceCount: 0, scheduleCount: 1 });

    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    expect(customer.archivedAt).not.toBeNull();
    const stored = await prisma.recurringInvoice.findUniqueOrThrow({ where: { id: recurring.id } });
    expect(stored.active).toBe(false);
  });

  it("does the same for a schedule that is already paused", async () => {
    await schedule({ active: false });
    const body = await readJson(await remove());
    expect(body).toMatchObject({ archived: true, scheduleCount: 1 });
  });

  it("still deletes a customer with neither invoices nor schedules", async () => {
    const body = await readJson(await remove());
    expect(body).toMatchObject({ deleted: true, archived: false, scheduleCount: 0 });
  });

  it("tells the detail screen how many schedules the customer has", async () => {
    await schedule();
    await schedule({ anchorDay: 2 });
    const detail = await readJson(
      await getCustomer(
        buildRequest("GET", `/api/customers/${customerId}`, undefined, { cookie }),
        routeContext({ id: customerId })
      )
    );
    expect(detail.recurringCount).toBe(2);
  });

  it("leaves the schedule alone when the customer is archived through PATCH only to be restored later", async () => {
    const recurring = await schedule();
    const archived = await patchCustomer(
      buildRequest("PATCH", `/api/customers/${customerId}`, { archived: true }, { cookie }),
      routeContext({ id: customerId })
    );
    expect(archived.status).toBe(200);
    // PATCH is the explicit, reversible path; it is not changed by this fix.
    const stored = await prisma.recurringInvoice.findUniqueOrThrow({ where: { id: recurring.id } });
    expect(stored.active).toBe(true);
  });
});
