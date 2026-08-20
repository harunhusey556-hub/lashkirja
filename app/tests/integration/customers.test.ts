import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { GET as listCustomers, POST as createCustomer } from "@/app/api/customers/route";
import {
  DELETE as deleteCustomer,
  GET as getCustomer,
  PATCH as patchCustomer,
} from "@/app/api/customers/[id]/route";
import { POST as createInvoice } from "@/app/api/invoices/route";
import { POST as setStatus } from "@/app/api/invoices/[id]/status/route";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie, type JsonValue } from "./helpers/http";

let user: TestUser;
let cookie: string;
let otherUser: TestUser;
let otherCookie: string;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  otherUser = await createUser();
  otherCookie = await sessionCookie(otherUser);
});

async function postCustomer(body: unknown, auth = cookie) {
  return createCustomer(buildRequest("POST", "/api/customers", body, { cookie: auth }));
}

async function makeCustomer(overrides: Record<string, unknown> = {}, auth = cookie) {
  const response = await postCustomer({ name: "Anna Asiakas", ...overrides }, auth);
  const { customer } = await readJson(response);
  return customer;
}

describe("POST /api/customers", () => {
  it("stores a customer with a validated Y-tunnus", async () => {
    const response = await postCustomer({
      name: "  Kauneus Oy  ",
      businessId: "02012566",
      email: "LASKUT@Kauneus.FI",
      defaultPaymentTermDays: 21,
    });

    expect(response.status).toBe(201);
    const { customer } = await readJson(response);
    expect(customer).toMatchObject({
      name: "Kauneus Oy", // trimmed
      businessId: "0201256-6", // normalised
      email: "laskut@kauneus.fi", // lowercased
      defaultPaymentTermDays: 21,
      country: "FI",
    });
  });

  it("defaults the payment term to 14 days", async () => {
    const customer = await makeCustomer();
    expect(customer.defaultPaymentTermDays).toBe(14);
  });

  it("rejects a Y-tunnus with a wrong check digit", async () => {
    const response = await postCustomer({ name: "Väärä Oy", businessId: "0201256-5" });
    expect(response.status).toBe(400);
    expect(await prisma.customer.count()).toBe(0);
  });

  it("rejects an impossible email", async () => {
    const response = await postCustomer({ name: "Asiakas", email: "not-an-email" });
    expect(response.status).toBe(400);
  });

  it("accepts a private person with no business id", async () => {
    const customer = await makeCustomer({ businessId: "" });
    expect(customer.businessId).toBeNull();
  });

  it("rejects a nameless customer", async () => {
    expect((await postCustomer({ name: "   " })).status).toBe(400);
  });

  it("requires a session and blocks cross-site posts", async () => {
    expect(
      (await createCustomer(buildRequest("POST", "/api/customers", { name: "X" }))).status
    ).toBe(401);
    expect(
      (
        await createCustomer(
          buildRequest("POST", "/api/customers", { name: "X" }, { cookie, secFetchSite: "cross-site" })
        )
      ).status
    ).toBe(403);
  });
});

describe("GET /api/customers", () => {
  it("reports invoiced totals and open balance per customer", async () => {
    const customer = await makeCustomer({ name: "Maksaja Oy" });

    const draft = await readJson(
      await createInvoice(
        buildRequest(
          "POST",
          "/api/invoices",
          {
            customerId: customer.id,
            issueDate: "2026-01-10",
            lines: [{ description: "Ripsienpidennys", quantity: 1, unitPrice: 100, vatRate: 25.5 }],
          },
          { cookie }
        )
      )
    );
    const sent = await readJson(
      await createInvoice(
        buildRequest(
          "POST",
          "/api/invoices",
          {
            customerId: customer.id,
            issueDate: "2026-01-20",
            lines: [{ description: "Huolto", quantity: 2, unitPrice: 50, vatRate: 25.5 }],
          },
          { cookie }
        )
      )
    );
    await setStatus(
      buildRequest("POST", `/api/invoices/${sent.invoice.id}/status`, { status: "sent" }, { cookie }),
      routeContext({ id: sent.invoice.id })
    );

    const { customers } = await readJson(
      await listCustomers(buildRequest("GET", "/api/customers", undefined, { cookie }))
    );
    const row = customers.find((c: JsonValue) => c.id === customer.id);
    expect(row.invoiceCount).toBe(2);
    expect(row.openInvoiceCount).toBe(1);
    // The draft is not receivable and not invoiced turnover.
    expect(row.invoicedTotal).toBe(125.5);
    expect(row.openBalance).toBe(125.5);
    expect(row.lastInvoiceDate).toBe("2026-01-20");
    expect(draft.invoice.status).toBe("draft");
  });

  it("filters by name and hides archived customers by default", async () => {
    await makeCustomer({ name: "Aino" });
    const bertta = await makeCustomer({ name: "Bertta" });
    await patchCustomer(
      buildRequest("PATCH", `/api/customers/${bertta.id}`, { archived: true }, { cookie }),
      routeContext({ id: bertta.id })
    );

    const visible = await readJson(
      await listCustomers(buildRequest("GET", "/api/customers", undefined, { cookie }))
    );
    expect(visible.customers.map((c: JsonValue) => c.name)).toEqual(["Aino"]);

    const all = await readJson(
      await listCustomers(
        buildRequest("GET", "/api/customers?includeArchived=1", undefined, { cookie })
      )
    );
    expect(all.customers).toHaveLength(2);

    const searched = await readJson(
      await listCustomers(buildRequest("GET", "/api/customers?search=Ain", undefined, { cookie }))
    );
    expect(searched.customers).toHaveLength(1);
  });

  it("never returns another user's customers", async () => {
    await makeCustomer({ name: "Toisen asiakas" }, otherCookie);
    const { customers } = await readJson(
      await listCustomers(buildRequest("GET", "/api/customers", undefined, { cookie }))
    );
    expect(customers).toEqual([]);
  });
});

describe("PATCH / DELETE /api/customers/[id]", () => {
  it("updates fields and clears optional ones with an empty string", async () => {
    const customer = await makeCustomer({ businessId: "0201256-6", phone: "040 1234567" });
    const response = await patchCustomer(
      buildRequest(
        "PATCH",
        `/api/customers/${customer.id}`,
        { name: "Uusi nimi", businessId: "", phone: "" },
        { cookie }
      ),
      routeContext({ id: customer.id })
    );
    const updated = (await readJson(response)).customer;
    expect(updated).toMatchObject({ name: "Uusi nimi", businessId: null, phone: null });
  });

  it("rejects an empty patch", async () => {
    const customer = await makeCustomer();
    const response = await patchCustomer(
      buildRequest("PATCH", `/api/customers/${customer.id}`, {}, { cookie }),
      routeContext({ id: customer.id })
    );
    expect(response.status).toBe(400);
  });

  it("deletes a customer that has never been invoiced", async () => {
    const customer = await makeCustomer();
    const body = await readJson(
      await deleteCustomer(
        buildRequest("DELETE", `/api/customers/${customer.id}`, undefined, { cookie }),
        routeContext({ id: customer.id })
      )
    );
    expect(body).toMatchObject({ deleted: true, archived: false });
    expect(await prisma.customer.count()).toBe(0);
  });

  it("archives instead of deleting once invoices exist", async () => {
    const customer = await makeCustomer();
    await createInvoice(
      buildRequest(
        "POST",
        "/api/invoices",
        {
          customerId: customer.id,
          issueDate: "2026-01-10",
          lines: [{ description: "Työ", quantity: 1, unitPrice: 10, vatRate: 25.5 }],
        },
        { cookie }
      )
    );

    const body = await readJson(
      await deleteCustomer(
        buildRequest("DELETE", `/api/customers/${customer.id}`, undefined, { cookie }),
        routeContext({ id: customer.id })
      )
    );
    expect(body).toMatchObject({ deleted: false, archived: true, invoiceCount: 1 });
    expect(await prisma.salesInvoice.count()).toBe(1);
  });

  it("404s on another user's customer for read, patch and delete", async () => {
    const foreign = await makeCustomer({ name: "Toisen" }, otherCookie);
    const context = routeContext({ id: foreign.id });
    expect(
      (await getCustomer(buildRequest("GET", `/api/customers/${foreign.id}`, undefined, { cookie }), context))
        .status
    ).toBe(404);
    expect(
      (
        await patchCustomer(
          buildRequest("PATCH", `/api/customers/${foreign.id}`, { name: "Kaapattu" }, { cookie }),
          context
        )
      ).status
    ).toBe(404);
    expect(
      (
        await deleteCustomer(
          buildRequest("DELETE", `/api/customers/${foreign.id}`, undefined, { cookie }),
          context
        )
      ).status
    ).toBe(404);
    expect(await prisma.customer.count({ where: { userId: otherUser.id } })).toBe(1);
  });
});
