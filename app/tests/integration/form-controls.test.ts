import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { POST as createCustomer, GET as listCustomers } from "@/app/api/customers/route";
import { PATCH as patchCustomer } from "@/app/api/customers/[id]/route";
import { POST as createInvoice } from "@/app/api/invoices/route";
import { PATCH as patchInvoice } from "@/app/api/invoices/[id]/route";
import { POST as setStatus } from "@/app/api/invoices/[id]/status/route";
import { POST as addPayment } from "@/app/api/invoices/[id]/payments/route";
import { PATCH as patchReceipt } from "@/app/api/receipts/[id]/route";
import { createReceipt, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;

const LINE = { description: "Työ", quantity: 1, unitPrice: 10, vatRate: 0 };

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

async function postCustomer(key: string, name = "Anna Asiakas") {
  return createCustomer(
    buildRequest("POST", "/api/customers", { name }, {
      cookie,
      headers: { "Idempotency-Key": key },
    })
  );
}

describe("double submit", () => {
  it("creates one customer when the same key is posted twice", async () => {
    const first = await postCustomer("customer-key");
    const second = await postCustomer("customer-key");
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const a = await readJson(first);
    const b = await readJson(second);
    expect(b.customer.id).toBe(a.customer.id);
    expect(await prisma.customer.count()).toBe(1);
    expect(await prisma.idempotencyRecord.count()).toBe(1);
  });

  it("creates one invoice when the same key is posted twice", async () => {
    const customer = await readJson(await postCustomer("once"));
    const body = { customerId: customer.customer.id, issueDate: "2026-03-01", lines: [LINE] };
    const headers = { "Idempotency-Key": "invoice-key" };
    const first = await createInvoice(buildRequest("POST", "/api/invoices", body, { cookie, headers }));
    const second = await createInvoice(buildRequest("POST", "/api/invoices", body, { cookie, headers }));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const a = await readJson(first);
    const b = await readJson(second);
    expect(b.invoice.id).toBe(a.invoice.id);
    expect(await prisma.salesInvoice.count()).toBe(1);
  });

  it("records one payment when the same key is posted twice", async () => {
    const customer = await readJson(await postCustomer("payer"));
    const created = await createInvoice(
      buildRequest(
        "POST",
        "/api/invoices",
        { customerId: customer.customer.id, issueDate: "2026-03-01", lines: [LINE] },
        { cookie, headers: { "Idempotency-Key": "inv" } }
      )
    );
    const invoice = (await readJson(created)).invoice;
    await setStatus(
      buildRequest("POST", `/api/invoices/${invoice.id}/status`, { status: "sent" }, { cookie }),
      routeContext({ id: invoice.id })
    );
    const payment = { amount: 10, paidDate: "2026-03-02" };
    const headers = { "Idempotency-Key": "pay-key" };
    const first = await addPayment(
      buildRequest("POST", `/api/invoices/${invoice.id}/payments`, payment, { cookie, headers }),
      routeContext({ id: invoice.id })
    );
    const second = await addPayment(
      buildRequest("POST", `/api/invoices/${invoice.id}/payments`, payment, { cookie, headers }),
      routeContext({ id: invoice.id })
    );
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await prisma.invoicePayment.count()).toBe(1);
  });

  it("still creates a second row when the keys differ", async () => {
    expect((await postCustomer("a", "A")).status).toBe(201);
    expect((await postCustomer("b", "B")).status).toBe(201);
    expect(await prisma.customer.count()).toBe(2);
  });
});

describe("concurrent edit", () => {
  it("does not overwrite a customer when the version is stale", async () => {
    const created = await readJson(await postCustomer("cust"));
    const stale = new Date(new Date(created.customer.updatedAt).getTime() - 1000).toISOString();
    const response = await patchCustomer(
      buildRequest(
        "PATCH",
        `/api/customers/${created.customer.id}`,
        { name: "Uusi nimi", expectedUpdatedAt: stale },
        { cookie }
      ),
      routeContext({ id: created.customer.id })
    );
    expect(response.status).toBe(409);
    const body = await readJson(response);
    expect(body.error.message).toContain("Lataa tiedot uudelleen");
    const stored = await prisma.customer.findUniqueOrThrow({ where: { id: created.customer.id } });
    expect(stored.name).toBe("Anna Asiakas");
  });

  it("saves a customer when the version still matches", async () => {
    const created = await readJson(await postCustomer("cust-ok"));
    const response = await patchCustomer(
      buildRequest(
        "PATCH",
        `/api/customers/${created.customer.id}`,
        { name: "Päivitetty", expectedUpdatedAt: created.customer.updatedAt },
        { cookie }
      ),
      routeContext({ id: created.customer.id })
    );
    expect(response.status).toBe(200);
    expect((await readJson(response)).customer.name).toBe("Päivitetty");
  });

  it("does not overwrite an invoice when the version is stale", async () => {
    const customer = await readJson(await postCustomer("inv-customer"));
    const created = await createInvoice(
      buildRequest(
        "POST",
        "/api/invoices",
        { customerId: customer.customer.id, issueDate: "2026-03-01", lines: [LINE] },
        { cookie }
      )
    );
    const invoice = (await readJson(created)).invoice;
    const stale = new Date(new Date(invoice.updatedAt).getTime() - 1000).toISOString();
    const response = await patchInvoice(
      buildRequest(
        "PATCH",
        `/api/invoices/${invoice.id}`,
        { notes: "muutos", expectedUpdatedAt: stale },
        { cookie }
      ),
      routeContext({ id: invoice.id })
    );
    expect(response.status).toBe(409);
    const stored = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(stored.notes).toBeNull();
  });

  it("does not overwrite a receipt when the version is stale", async () => {
    const receipt = await createReceipt(user.id, { vendor: "Alkuperäinen" });
    const stale = new Date(receipt.updatedAt.getTime() - 1000).toISOString();
    const response = await patchReceipt(
      buildRequest(
        "PATCH",
        `/api/receipts/${receipt.id}`,
        { vendor: "Toinen", expectedUpdatedAt: stale },
        { cookie }
      ),
      routeContext({ id: receipt.id })
    );
    expect(response.status).toBe(409);
    const stored = await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } });
    expect(stored.vendor).toBe("Alkuperäinen");
  });
});

describe("customer list still answers", () => {
  it("includes updatedAt for the editor", async () => {
    await postCustomer("listed");
    const response = await listCustomers(buildRequest("GET", "/api/customers", undefined, { cookie }));
    const body = await readJson(response);
    expect(body.customers[0].updatedAt).toEqual(expect.any(String));
  });
});
