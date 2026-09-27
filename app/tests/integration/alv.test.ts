import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { GET as alvReport } from "@/app/api/alv/route";
import { POST as createCustomer } from "@/app/api/customers/route";
import { POST as createInvoice } from "@/app/api/invoices/route";
import { POST as setStatus } from "@/app/api/invoices/[id]/status/route";
import { POST as addPayment } from "@/app/api/invoices/[id]/payments/route";
import {
  createBankAccountRow,
  createReceipt,
  createStatementWithTransactions,
  createUser,
  resetDatabase,
  type TestUser,
} from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;
let otherUser: TestUser;
let customerId: string;

const VAT_255 = JSON.stringify([{ rate: 25.5, amount: 25.5 }]);

async function makeCustomer() {
  const response = await createCustomer(
    buildRequest("POST", "/api/customers", { name: "Anna Asiakas" }, { cookie })
  );
  return (await readJson(response)).customer.id as string;
}

async function makeInvoice(overrides: Record<string, unknown> = {}) {
  const response = await createInvoice(
    buildRequest(
      "POST",
      "/api/invoices",
      {
        customerId,
        issueDate: "2026-01-15",
        lines: [{ description: "Ripsienpidennys", quantity: 1, unitPrice: 100, vatRate: 25.5 }],
        ...overrides,
      },
      { cookie }
    )
  );
  expect(response.status).toBe(201);
  return (await readJson(response)).invoice;
}

async function send(invoiceId: string) {
  await setStatus(
    buildRequest("POST", `/api/invoices/${invoiceId}/status`, { status: "sent" }, { cookie }),
    routeContext({ id: invoiceId })
  );
}

async function report(period = "2026-01") {
  const response = await alvReport(
    buildRequest("GET", `/api/alv?period=${period}`, undefined, { cookie })
  );
  expect(response.status).toBe(200);
  return readJson(response);
}

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  otherUser = await createUser();
  customerId = await makeCustomer();
});

describe("GET /api/alv - period boundaries", () => {
  it("uses UTC month bounds, so the first and last day land in the right period", async () => {
    await createReceipt(user.id, { type: "tulo", date: "2026-01-01", totalAmountCents: 125_50, vatDetails: VAT_255 });
    await createReceipt(user.id, { type: "tulo", date: "2026-01-31", totalAmountCents: 125_50, vatDetails: VAT_255 });
    await createReceipt(user.id, { type: "tulo", date: "2025-12-31", totalAmountCents: 999_00, vatDetails: VAT_255 });
    await createReceipt(user.id, { type: "tulo", date: "2026-02-01", totalAmountCents: 999_00, vatDetails: VAT_255 });

    const january = await report("2026-01");
    expect(january.receiptCount).toBe(2);
    expect(january.field301.vat).toBe(51);
  });

  it("supports a quarter period", async () => {
    await createReceipt(user.id, { type: "tulo", date: "2026-02-10", totalAmountCents: 125_50, vatDetails: VAT_255 });
    await createReceipt(user.id, { type: "tulo", date: "2026-04-10", totalAmountCents: 125_50, vatDetails: VAT_255 });

    const q1 = await report("2026-Q1");
    expect(q1.receiptCount).toBe(1);
    expect(q1.period.start).toBe("2026-01-01T00:00:00.000Z");
    expect(q1.period.end).toBe("2026-04-01T00:00:00.000Z");
  });

  it("rejects a malformed period instead of silently reporting another month", async () => {
    const response = await alvReport(
      buildRequest("GET", "/api/alv?period=2026-13", undefined, { cookie })
    );
    expect(response.status).toBe(400);
  });

  it("requires a session", async () => {
    expect((await alvReport(buildRequest("GET", "/api/alv?period=2026-01"))).status).toBe(401);
  });
});

describe("GET /api/alv - sales invoices", () => {
  it("counts a sent invoice's VAT in field 301", async () => {
    const invoice = await makeInvoice();
    await send(invoice.id);

    const body = await report();
    expect(body.field301).toMatchObject({ netSales: 100, vat: 25.5 });
    expect(body.sources).toMatchObject({ invoiceSalesVat: 25.5, invoiceCount: 1 });
    expect(body.field308).toMatchObject({ amount: 25.5, isRefund: false });
  });

  it("leaves drafts and credit notes out", async () => {
    await makeInvoice(); // stays a draft
    const credited = await makeInvoice();
    await send(credited.id);
    const { POST: creditInvoice } = await import("@/app/api/invoices/[id]/credit/route");
    const credit = await creditInvoice(
      buildRequest("POST", `/api/invoices/${credited.id}/credit`, {}, { cookie }),
      routeContext({ id: credited.id })
    );
    expect(credit.status).toBe(201);

    const body = await report();
    expect(body.sources.invoiceCount).toBe(0);
    expect(body.field301.vat).toBe(0);
    expect(body.creditedInvoiceCount).toBe(1);
  });

  it("reports an invoice by its issue date, not by when it was paid", async () => {
    const invoice = await makeInvoice({ issueDate: "2026-01-20", dueDate: "2026-02-20" });
    await send(invoice.id);
    await addPayment(
      buildRequest(
        "POST",
        `/api/invoices/${invoice.id}/payments`,
        { amount: 125.5, paidDate: "2026-02-05" },
        { cookie }
      ),
      routeContext({ id: invoice.id })
    );

    expect((await report("2026-01")).sources.invoiceCount).toBe(1);
    expect((await report("2026-02")).sources.invoiceCount).toBe(0);
  });

  it("keeps a zero-rated invoice out of VAT and in turnover", async () => {
    const invoice = await makeInvoice({
      lines: [{ description: "Vienti", quantity: 1, unitPrice: 500, vatRate: 0 }],
    });
    await send(invoice.id);

    const body = await report();
    expect(body.field309.turnover).toBe(500);
    expect(body.field301.vat).toBe(0);
  });

  it("never counts another user's invoices", async () => {
    const foreignCustomer = await prisma.customer.create({
      data: { userId: otherUser.id, name: "Toisen asiakas" },
    });
    await prisma.salesInvoice.create({
      data: {
        userId: otherUser.id,
        customerId: foreignCustomer.id,
        number: 1,
        reference: "1234561",
        issueDate: new Date("2026-01-15T00:00:00Z"),
        dueDate: new Date("2026-01-29T00:00:00Z"),
        status: "sent",
        netCents: 10_000,
        vatCents: 2_550,
        grossCents: 12_550,
        lines: {
          create: [
            {
              description: "Työ",
              quantityMilli: 1000,
              unitPriceCents: 10_000,
              vatRatePermille: 255,
              netCents: 10_000,
            },
          ],
        },
      },
    });

    const body = await report();
    expect(body.sources.invoiceCount).toBe(0);
  });
});

describe("GET /api/alv - double counting", () => {
  async function payInvoiceFromBank() {
    const account = await createBankAccountRow(user.id, { name: "Nordea" });
    const invoice = await makeInvoice();
    await send(invoice.id);

    const statement = await createStatementWithTransactions(user.id, {
      bankAccountId: account.id,
      transactions: [{ date: "2026-01-20", amountCents: 125_50 }],
    });
    const transactionId = statement.transactions[0].id;

    await addPayment(
      buildRequest(
        "POST",
        `/api/invoices/${invoice.id}/payments`,
        { amount: 125.5, paidDate: "2026-01-20", transactionId },
        { cookie }
      ),
      routeContext({ id: invoice.id })
    );
    return { invoice, transactionId };
  }

  it("counts a paid invoice once, not twice, when an income receipt was drafted from the same bank row", async () => {
    const { transactionId } = await payInvoiceFromBank();

    // The income automation drafts a receipt from that very bank row.
    await prisma.receipt.create({
      data: {
        userId: user.id,
        type: "tulo",
        date: new Date("2026-01-20T00:00:00Z"),
        totalAmountCents: 125_50,
        vatDetails: VAT_255,
        sourceTransactionId: transactionId,
        reviewStatus: "approved",
        source: "auto_income",
        filePath: "/tmp/auto.pdf",
        fileName: "auto.pdf",
      },
    });

    const body = await report();
    expect(body.excludedReceiptCount).toBe(1);
    expect(body.receiptCount).toBe(0);
    expect(body.field301.vat).toBe(25.5); // the invoice only
    expect(body.sources).toMatchObject({ receiptSalesVat: 0, invoiceSalesVat: 25.5 });
  });

  it("also excludes a receipt that is confirm-matched to the settling bank row", async () => {
    const { transactionId } = await payInvoiceFromBank();

    const receipt = await createReceipt(user.id, {
      type: "tulo",
      date: "2026-01-20",
      totalAmountCents: 125_50,
      vatDetails: VAT_255,
    });
    await prisma.transaction.update({
      where: { id: transactionId },
      data: { receiptId: receipt.id, matchStatus: "confirmed" },
    });

    const body = await report();
    expect(body.excludedReceiptCount).toBe(1);
    expect(body.field301.vat).toBe(25.5);
  });

  it("keeps an unrelated income receipt in the return", async () => {
    await payInvoiceFromBank();
    await createReceipt(user.id, {
      type: "tulo",
      date: "2026-01-25",
      totalAmountCents: 125_50,
      vatDetails: VAT_255,
    });

    const body = await report();
    expect(body.excludedReceiptCount).toBe(0);
    expect(body.receiptCount).toBe(1);
    expect(body.field301.vat).toBe(51); // invoice 25,50 + receipt 25,50
  });

  it("still deducts purchase VAT alongside invoice sales", async () => {
    const invoice = await makeInvoice();
    await send(invoice.id);
    await createReceipt(user.id, {
      type: "meno",
      date: "2026-01-10",
      totalAmountCents: 62_75,
      vatDetails: JSON.stringify([{ rate: 25.5, amount: 12.75 }]),
    });

    const body = await report();
    expect(body.field307.amount).toBe(12.75);
    expect(body.field308).toMatchObject({ amount: 12.75, isRefund: false });
  });
});

describe("dashboard VAT estimate matches the return", () => {
  it("uses the same sources, invoices and exclusions", async () => {
    const { GET: dashboard } = await import("@/app/api/dashboard/route");

    const invoice = await makeInvoice();
    await send(invoice.id);
    await createReceipt(user.id, {
      type: "meno",
      date: "2026-01-10",
      totalAmountCents: 62_75,
      vatDetails: JSON.stringify([{ rate: 25.5, amount: 12.75 }]),
    });

    const body = await readJson(
      await dashboard(buildRequest("GET", "/api/dashboard?month=2026-01", undefined, { cookie }))
    );
    const alv = await report("2026-01");

    expect(body.estimatedVat).toBe(12.75);
    expect(body.isRefund).toBe(false);
    expect(body.estimatedVat).toBe(alv.field308.amount);
  });

  it("reports a refund month with a negative estimate", async () => {
    const { GET: dashboard } = await import("@/app/api/dashboard/route");
    await createReceipt(user.id, {
      type: "meno",
      date: "2026-01-10",
      totalAmountCents: 1_000_00,
      vatDetails: JSON.stringify([{ rate: 25.5, amount: 200 }]),
    });

    const body = await readJson(
      await dashboard(buildRequest("GET", "/api/dashboard?month=2026-01", undefined, { cookie }))
    );
    expect(body.estimatedVat).toBe(-200);
    expect(body.isRefund).toBe(true);
  });
});
