import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { POST as createCustomer } from "@/app/api/customers/route";
import { POST as createInvoice } from "@/app/api/invoices/route";
import { DELETE as deleteInvoice } from "@/app/api/invoices/[id]/route";
import { POST as duplicateInvoice } from "@/app/api/invoices/[id]/duplicate/route";
import { POST as setStatus } from "@/app/api/invoices/[id]/status/route";
import { PUT as setSequence } from "@/app/api/invoices/sequence/route";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;
let customerId: string;

const LINE = { description: "Ripsienpidennys", quantity: 1, unitPrice: 100, vatRate: 25.5 };

async function makeInvoice() {
  const response = await createInvoice(
    buildRequest(
      "POST",
      "/api/invoices",
      { customerId, issueDate: "2026-01-15", dueDate: "2026-01-29", lines: [LINE] },
      { cookie }
    )
  );
  expect(response.status).toBe(201);
  return (await readJson(response)).invoice;
}

async function remove(id: string) {
  const response = await deleteInvoice(
    buildRequest("DELETE", `/api/invoices/${id}`, undefined, { cookie }),
    routeContext({ id })
  );
  expect(response.status).toBe(200);
}

async function copy(id: string) {
  const response = await duplicateInvoice(
    buildRequest("POST", `/api/invoices/${id}/duplicate`, {}, { cookie }),
    routeContext({ id })
  );
  expect(response.status).toBe(201);
  return (await readJson(response)).invoice;
}

async function nextNumber(): Promise<number> {
  return (await prisma.invoiceSequence.findUniqueOrThrow({ where: { userId: user.id } })).nextNumber;
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

describe("gapless invoice numbers (F08)", () => {
  it("gives the number of the newest unsent draft back when it is deleted", async () => {
    const first = await makeInvoice();
    const second = await copy(first.id);
    expect(second.number).toBe(2);
    await remove(second.id);
    expect(await nextNumber()).toBe(2);
    const third = await makeInvoice();
    expect(third.number).toBe(2);
  });

  it("does not move a number that is in the middle of the series", async () => {
    const a = await makeInvoice();
    const b = await makeInvoice();
    const c = await makeInvoice();
    await remove(b.id);
    expect(await nextNumber()).toBe(4);
    const d = await makeInvoice();
    expect([a.number, c.number, d.number]).toEqual([1, 3, 4]);
  });

  it("never gives back a number that was sent, even when the invoice is a draft again", async () => {
    const first = await makeInvoice();
    const sent = await setStatus(
      buildRequest("POST", `/api/invoices/${first.id}/status`, { status: "sent" }, { cookie }),
      routeContext({ id: first.id })
    );
    expect(sent.status).toBe(200);
    const back = await setStatus(
      buildRequest("POST", `/api/invoices/${first.id}/status`, { status: "draft" }, { cookie }),
      routeContext({ id: first.id })
    );
    expect(back.status).toBe(200);
    await remove(first.id);
    expect(await nextNumber()).toBe(2);
  });

  it("keeps a requested starting number when the draft that used it is deleted", async () => {
    await makeInvoice();
    await setSequence(buildRequest("PUT", "/api/invoices/sequence", { startingNumber: 50 }, { cookie }));
    const jumped = await makeInvoice();
    expect(jumped.number).toBe(50);
    await remove(jumped.id);
    // The deleted draft gives 50 back, not 2: the start is a deliberate floor.
    expect(await nextNumber()).toBe(50);
    expect((await makeInvoice()).number).toBe(50);
  });
});
