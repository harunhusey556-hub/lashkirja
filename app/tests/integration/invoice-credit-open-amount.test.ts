import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { GET as listInvoices, POST as createInvoice } from "@/app/api/invoices/route";
import { GET as overdueList } from "@/app/api/invoices/overdue/route";
import { POST as setStatus } from "@/app/api/invoices/[id]/status/route";
import { POST as creditInvoice } from "@/app/api/invoices/[id]/credit/route";
import { POST as addPayment } from "@/app/api/invoices/[id]/payments/route";
import { POST as createCustomer } from "@/app/api/customers/route";
import { getCustomerDetail } from "@/lib/customers";
import { matchInvoicePaymentsFromBank } from "@/lib/sales-invoices";
import { previewReminder } from "@/lib/invoice-reminders";
import { helsinkiCalendarDate } from "@/lib/validation";
import { createStatementWithTransactions, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

/**
 * W11: a part credit leaves the sales invoice "sent" with its full gross, so
 * what is still owed is gross - paid - credited. The list, the reminder, the
 * payment cap and the bank matching all read that, not the gross.
 */

let user: TestUser;
let cookie: string;
let customerId: string;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** 1 kpl x 100,00 EUR at 0 % VAT: gross 100,00, so 40 % credited is exactly 40,00. */
const LINE = { description: "Ripsienpidennys", quantity: 1, unitPrice: 100, vatRate: 0 };

async function makeSentInvoice(overrides: Record<string, unknown> = {}): Promise<Json> {
  const today = helsinkiCalendarDate();
  const created = await createInvoice(
    buildRequest(
      "POST",
      "/api/invoices",
      { customerId, issueDate: today, dueDate: today, lines: [LINE], ...overrides },
      { cookie }
    )
  );
  expect(created.status).toBe(201);
  const id = (await readJson(created)).invoice.id;
  const sent = await setStatus(
    buildRequest("POST", `/api/invoices/${id}/status`, { status: "sent" }, { cookie }),
    routeContext({ id })
  );
  expect(sent.status).toBe(200);
  return (await readJson(sent)).invoice;
}

async function creditPart(invoice: Json, quantity: number) {
  const response = await creditInvoice(
    buildRequest(
      "POST",
      `/api/invoices/${invoice.id}/credit`,
      { lines: [{ lineId: invoice.lines[0].id, quantity }] },
      { cookie }
    ),
    routeContext({ id: invoice.id })
  );
  expect(response.status).toBe(201);
}

async function listed(id: string): Promise<Json> {
  const response = await listInvoices(buildRequest("GET", "/api/invoices", undefined, { cookie }));
  return ((await readJson(response)).invoices as Json[]).find((invoice) => invoice.id === id) as Json;
}

function pay(id: string, amount: number) {
  return addPayment(
    buildRequest("POST", `/api/invoices/${id}/payments`, { amount, paidDate: helsinkiCalendarDate() }, { cookie }),
    routeContext({ id })
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

describe("a sales invoice credited 40 of 100", () => {
  it("shows open 60, credited 40 and stays sent - the list's badge reads credited between 0 and gross", async () => {
    const invoice = await makeSentInvoice();
    await creditPart(invoice, 0.4);

    const row = await listed(invoice.id);
    expect(row).toMatchObject({ status: "sent", displayStatus: "sent", gross: 100, credited: 40, open: 60 });
    // The list shows "Osittain hyvitetty" when 0 < credited < gross (laskut/page.tsx isPartlyCredited).
    expect(row.credited).toBeGreaterThan(0);
    expect(row.credited).toBeLessThan(row.gross);
  });

  it("takes the reduced amount to the reminder list and the reminder", async () => {
    const invoice = await makeSentInvoice({ issueDate: "2026-01-01", dueDate: "2026-01-15" });
    await creditPart(invoice, 0.4);

    const overdue = (await readJson(await overdueList(buildRequest("GET", "/api/invoices/overdue", undefined, { cookie }))))
      .invoices as Json[];
    expect(overdue).toHaveLength(1);
    expect(overdue[0].open).toBe(60);

    const preview = await previewReminder(user.id, invoice.id, new Date("2026-03-01T10:00:00.000Z"));
    expect(preview.open).toBe(60);
  });

  it("lets a payment cover only the 60 that is left, and the 60 settles the invoice", async () => {
    const invoice = await makeSentInvoice();
    await creditPart(invoice, 0.4);

    const tooMuch = await pay(invoice.id, 100);
    expect(tooMuch.status).toBe(422);

    const settled = await pay(invoice.id, 60);
    expect(settled.status).toBe(201);
    expect((await readJson(settled)).invoice).toMatchObject({ status: "paid", open: 0, paid: 60, credited: 40 });
  });

  it("is settled by the credit when the payments already cover the rest", async () => {
    const invoice = await makeSentInvoice();
    expect((await pay(invoice.id, 60)).status).toBe(201);
    await creditPart(invoice, 0.4);
    expect(await listed(invoice.id)).toMatchObject({ status: "paid", open: 0 });
  });

  it("matches the bank payment of the 60 by its reference (not the gross)", async () => {
    const invoice = await makeSentInvoice();
    await creditPart(invoice, 0.4);
    const statement = await createStatementWithTransactions(user.id, {
      transactions: [{ date: helsinkiCalendarDate(), amountCents: 6_000, counterparty: "Anna Asiakas" }],
    });
    await prisma.transaction.update({
      where: { id: statement.transactions[0].id },
      data: { reference: invoice.reference },
    });

    const result = await matchInvoicePaymentsFromBank(user.id);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toMatchObject({ invoiceId: invoice.id, amount: 60 });
    expect(await listed(invoice.id)).toMatchObject({ status: "paid", open: 0 });
  });

  it("counts only the 60 in the customer's open balance", async () => {
    const invoice = await makeSentInvoice();
    await creditPart(invoice, 0.4);
    const detail = await getCustomerDetail(user.id, customerId);
    expect(detail.openBalance).toBe(60);
    expect(invoice.gross).toBe(100);
  });

  it("a credit of the whole invoice is unchanged: credited, nothing open", async () => {
    const invoice = await makeSentInvoice();
    await creditPart(invoice, 1);
    expect(await listed(invoice.id)).toMatchObject({ status: "credited", open: 0 });
  });
});
