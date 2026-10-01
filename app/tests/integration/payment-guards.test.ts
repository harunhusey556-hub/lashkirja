import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { POST as createCustomer } from "@/app/api/customers/route";
import { POST as createInvoice } from "@/app/api/invoices/route";
import { POST as setStatus } from "@/app/api/invoices/[id]/status/route";
import { POST as createPurchase } from "@/app/api/purchase-invoices/route";
import { POST as addPurchasePayment } from "@/app/api/purchase-invoices/[id]/payments/route";
import { POST as addPayment } from "@/app/api/invoices/[id]/payments/route";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;
let customerId: string;

// 100 + 25,5 % VAT = 125,50
const LINE = { description: "Ripsienpidennys", quantity: 1, unitPrice: 100, vatRate: 25.5 };

async function sentInvoice(overrides: Record<string, unknown> = {}) {
  const created = await readJson(
    await createInvoice(
      buildRequest(
        "POST",
        "/api/invoices",
        { customerId, issueDate: "2026-01-15", dueDate: "2026-01-29", lines: [LINE], ...overrides },
        { cookie }
      )
    )
  );
  const invoice = created.invoice;
  await setStatus(
    buildRequest("POST", `/api/invoices/${invoice.id}/status`, { status: "sent" }, { cookie }),
    routeContext({ id: invoice.id })
  );
  return invoice;
}

function pay(
  id: string,
  body: { amount: number; paidDate?: string },
  headers: Record<string, string> = {}
) {
  return addPayment(
    buildRequest(
      "POST",
      `/api/invoices/${id}/payments`,
      { paidDate: "2026-01-20", ...body },
      { cookie, headers }
    ),
    routeContext({ id })
  );
}

const paymentCount = (invoiceId: string) => prisma.invoicePayment.count({ where: { invoiceId } });

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  const customer = await readJson(
    await createCustomer(
      buildRequest(
        "POST",
        "/api/customers",
        { name: "Anna Asiakas", email: "anna@example.fi" },
        { cookie }
      )
    )
  );
  customerId = customer.customer.id;
});

describe("payment over the open balance", () => {
  it("refuses a payment larger than the open balance and names the balance", async () => {
    const invoice = await sentInvoice();
    const response = await pay(invoice.id, { amount: 500 });
    expect(response.status).toBe(422);
    const error = (await readJson(response)).error;
    expect(error.code).toBe("PAYMENT_EXCEEDS_OPEN");
    expect(error.message).toContain("125,50");
    expect(await paymentCount(invoice.id)).toBe(0);
  });

  it("measures the balance after earlier payments, and accepts exactly the rest", async () => {
    const invoice = await sentInvoice();
    expect((await pay(invoice.id, { amount: 100 })).status).toBe(201);

    const over = await pay(invoice.id, { amount: 30 });
    expect(over.status).toBe(422);
    expect((await readJson(over)).error.message).toContain("25,50");

    const rest = await pay(invoice.id, { amount: 25.5 });
    expect(rest.status).toBe(201);
    expect((await readJson(rest)).invoice).toMatchObject({ status: "paid", open: 0 });
  });

  it("answers a payment on a settled invoice with the settled state", async () => {
    const invoice = await sentInvoice();
    expect((await pay(invoice.id, { amount: 125.5 })).status).toBe(201);
    const again = await pay(invoice.id, { amount: 125.5 });
    expect(again.status).toBe(422);
    expect((await readJson(again)).error.message).toMatch(/jo maksettu/);
    expect(await paymentCount(invoice.id)).toBe(1);
  });

  it("books one payment when the same full payment is sent twice with different keys", async () => {
    const invoice = await sentInvoice();
    const first = await pay(invoice.id, { amount: 125.5 }, { "Idempotency-Key": "phone" });
    const second = await pay(invoice.id, { amount: 125.5 }, { "Idempotency-Key": "tablet" });
    expect([first.status, second.status]).toEqual([201, 422]);
    expect(await paymentCount(invoice.id)).toBe(1);
  });

  it("books one payment when two full payments arrive at the same time", async () => {
    const invoice = await sentInvoice();
    const responses = await Promise.all([
      pay(invoice.id, { amount: 125.5 }, { "Idempotency-Key": "phone" }),
      pay(invoice.id, { amount: 125.5 }, { "Idempotency-Key": "tablet" }),
      pay(invoice.id, { amount: 125.5 }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 422, 422]);
    expect(await paymentCount(invoice.id)).toBe(1);
    const stored = await prisma.salesInvoice.findUnique({ where: { id: invoice.id } });
    expect(stored?.status).toBe("paid");
  });
});

describe("payment amount and date", () => {
  it("refuses zero and negative amounts at the API", async () => {
    const invoice = await sentInvoice();
    expect((await pay(invoice.id, { amount: 0 })).status).toBe(400);
    const negative = await pay(invoice.id, { amount: -5 });
    expect(negative.status).toBe(400);
    expect((await readJson(negative)).error.message).toMatch(/suurempi kuin nolla/);
    expect(await paymentCount(invoice.id)).toBe(0);
  });

  it("refuses a payment dated before the invoice and accepts the invoice day itself", async () => {
    const invoice = await sentInvoice({ issueDate: "2026-01-15", dueDate: "2026-01-29" });
    const early = await pay(invoice.id, { amount: 5, paidDate: "2026-01-01" });
    expect(early.status).toBe(422);
    const error = (await readJson(early)).error;
    expect(error.code).toBe("PAYMENT_BEFORE_INVOICE");
    expect(error.message).toContain("15.1.2026");
    expect(await paymentCount(invoice.id)).toBe(0);

    expect((await pay(invoice.id, { amount: 5, paidDate: "2026-01-15" })).status).toBe(201);
  });

  it("refuses a payment dated in the future", async () => {
    const invoice = await sentInvoice();
    const future = await pay(invoice.id, { amount: 5, paidDate: "2999-01-01" });
    expect(future.status).toBe(422);
    expect((await readJson(future)).error.code).toBe("PAYMENT_IN_FUTURE");
    expect(await paymentCount(invoice.id)).toBe(0);
  });
});

describe("purchase payment over the open balance", () => {
  async function payable() {
    const response = await createPurchase(
      buildRequest(
        "POST",
        "/api/purchase-invoices",
        { supplierName: "Tukku Oy", issueDate: "2026-01-10", dueDate: "2026-01-24", gross: 50, vat: 0 },
        { cookie }
      )
    );
    expect(response.status).toBe(201);
    return (await readJson(response)).invoice;
  }
  const payPayable = (id: string, amount: number) =>
    addPurchasePayment(
      buildRequest(
        "POST",
        `/api/purchase-invoices/${id}/payments`,
        { amount, paidDate: "2026-01-20" },
        { cookie }
      ),
      routeContext({ id })
    );

  it("refuses 500 euros on a 50 euro payable and names the open balance", async () => {
    const invoice = await payable();
    const response = await payPayable(invoice.id, 500);
    expect(response.status).toBe(422);
    const error = (await readJson(response)).error;
    expect(error.code).toBe("PAYMENT_EXCEEDS_OPEN");
    expect(error.message).toContain("50,00");
    expect(await prisma.purchasePayment.count({ where: { purchaseInvoiceId: invoice.id } })).toBe(0);
  });

  it("books one payment when the same full payment arrives twice at once", async () => {
    const invoice = await payable();
    const responses = await Promise.all([payPayable(invoice.id, 50), payPayable(invoice.id, 50)]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 422]);
    expect(await prisma.purchasePayment.count({ where: { purchaseInvoiceId: invoice.id } })).toBe(1);
  });
});
