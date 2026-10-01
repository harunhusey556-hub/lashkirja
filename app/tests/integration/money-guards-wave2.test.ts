import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { GET as alvReport } from "@/app/api/alv/route";
import { POST as createCustomer } from "@/app/api/customers/route";
import { POST as createInvoice } from "@/app/api/invoices/route";
import { POST as setStatus } from "@/app/api/invoices/[id]/status/route";
import {
  DELETE as removeInvoicePayment,
  POST as addPayment,
} from "@/app/api/invoices/[id]/payments/route";
import { POST as createPurchase } from "@/app/api/purchase-invoices/route";
import { POST as addPurchasePayment } from "@/app/api/purchase-invoices/[id]/payments/route";
import { POST as confirmMatchRoute } from "@/app/api/matching/confirm/route";
import { PATCH as reviewReceipt } from "@/app/api/receipts/[id]/review/route";
import { PUT as setLock } from "@/app/api/period-lock/route";
import { autoGenerateIncomeReceipts } from "@/lib/income-automation";
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
let customerId: string;

const VAT_255 = JSON.stringify([{ rate: 25.5, amount: 25.5 }]);

async function bankRow(opts: { date: string; amountCents: number }) {
  const account = await createBankAccountRow(user.id, { name: "Nordea" });
  const statement = await createStatementWithTransactions(user.id, {
    bankAccountId: account.id,
    periodMonth: opts.date.slice(0, 7),
    transactions: [{ date: opts.date, amountCents: opts.amountCents, counterparty: "Asiakas Oy" }],
  });
  return { statement, row: statement.transactions[0] };
}

async function sentInvoice(issueDate = "2026-09-20") {
  const created = await createInvoice(
    buildRequest(
      "POST",
      "/api/invoices",
      {
        customerId,
        issueDate,
        lines: [{ description: "Ripsienpidennys", quantity: 1, unitPrice: 100, vatRate: 25.5 }],
      },
      { cookie }
    )
  );
  expect(created.status).toBe(201);
  const invoice = (await readJson(created)).invoice;
  await setStatus(
    buildRequest("POST", `/api/invoices/${invoice.id}/status`, { status: "sent" }, { cookie }),
    routeContext({ id: invoice.id })
  );
  return invoice as { id: string };
}

function pay(id: string, body: Record<string, unknown>) {
  return addPayment(
    buildRequest("POST", `/api/invoices/${id}/payments`, body, { cookie }),
    routeContext({ id })
  );
}

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  const customer = await createCustomer(
    buildRequest("POST", "/api/customers", { name: "Anna Asiakas" }, { cookie })
  );
  customerId = (await readJson(customer)).customer.id;
});

describe("R51/V39: a payment that carries a bank row is bank-sourced", () => {
  it("accepts the bank row of an amount above the open balance and stores it as a bank payment", async () => {
    const invoice = await sentInvoice();
    const { row } = await bankRow({ date: "2026-09-25", amountCents: 133_90 });
    const response = await pay(invoice.id, { amount: 133.9, paidDate: "2026-09-25", transactionId: row.id });
    expect(response.status).toBe(201);
    const stored = await prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    expect(stored.source).toBe("bank");
    expect(stored.transactionId).toBe(row.id);
  });

  it("accepts a bank row dated before the invoice", async () => {
    const invoice = await sentInvoice("2026-09-20");
    const { row } = await bankRow({ date: "2026-09-10", amountCents: 125_50 });
    const response = await pay(invoice.id, { amount: 125.5, paidDate: "2026-09-10", transactionId: row.id });
    expect(response.status).toBe(201);
  });

  it("still refuses the same overpayment and early date when no bank row is given", async () => {
    const invoice = await sentInvoice("2026-09-20");
    expect((await pay(invoice.id, { amount: 133.9, paidDate: "2026-09-25" })).status).toBe(422);
    expect((await pay(invoice.id, { amount: 5, paidDate: "2026-09-10" })).status).toBe(422);
  });
});

async function alvFigures() {
  const response = await alvReport(buildRequest("GET", "/api/alv?period=2026-09", undefined, { cookie }));
  expect(response.status).toBe(200);
  const body = await readJson(response);
  return { field301: body.field301, field302: body.field302, receiptCount: body.receiptCount };
}

async function paidSaleWithApprovedDraft() {
  const { statement, row } = await bankRow({ date: "2026-09-20", amountCents: 125_50 });
  const invoice = await sentInvoice();
  await autoGenerateIncomeReceipts(user.id, statement.id);
  const draft = await prisma.receipt.findFirstOrThrow({ where: { sourceTransactionId: row.id } });
  await prisma.receipt.update({ where: { id: draft.id }, data: { vatDetails: VAT_255 } });
  const paid = await pay(invoice.id, { amount: 125.5, paidDate: "2026-09-20", transactionId: row.id });
  expect(paid.status).toBe(201);
  const approved = await reviewReceipt(
    buildRequest("PATCH", `/api/receipts/${draft.id}/review`, { reviewStatus: "approved" }, { cookie }),
    routeContext({ id: draft.id })
  );
  expect(approved.status).toBe(200);
  const payment = await prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId: invoice.id } });
  return { invoice, row, draft, payment };
}

function removePayment(invoiceId: string, paymentId: string) {
  return removeInvoicePayment(
    buildRequest("DELETE", `/api/invoices/${invoiceId}/payments?paymentId=${paymentId}`, undefined, { cookie }),
    routeContext({ id: invoiceId })
  );
}

describe("V18: removing a bank-linked payment keeps the sale counted once", () => {
  it("does not put the approved sale draft back into the VAT return", async () => {
    const { invoice, payment } = await paidSaleWithApprovedDraft();
    const before = await alvFigures();
    expect(before.field301).toMatchObject({ netSales: 100, vat: 25.5 });

    expect((await removePayment(invoice.id, payment.id)).status).toBe(200);

    expect(await alvFigures()).toEqual(before);
  });

  it("sends the sale draft back to waiting for approval and frees its bank row", async () => {
    const { invoice, payment, draft, row } = await paidSaleWithApprovedDraft();
    expect((await removePayment(invoice.id, payment.id)).status).toBe(200);

    expect(await prisma.receipt.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({
      reviewStatus: "pending",
    });
    expect(await prisma.transaction.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      receiptId: null,
      matchStatus: "unmatched",
    });
  });

  it("refuses the removal when the sale draft sits in a closed month", async () => {
    const { invoice, payment, draft } = await paidSaleWithApprovedDraft();
    await prisma.user.update({ where: { id: user.id }, data: { booksLockedThrough: "2026-09" } });
    const response = await removePayment(invoice.id, payment.id);
    expect(response.status).toBe(409);
    expect((await readJson(response)).error.code).toBe("PERIOD_LOCKED");
    expect(await prisma.invoicePayment.count({ where: { id: payment.id } })).toBe(1);
    expect(await prisma.receipt.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({
      reviewStatus: "approved",
    });
  });

  it("leaves a hand-recorded payment (no bank row) alone", async () => {
    const invoice = await sentInvoice();
    const paid = await pay(invoice.id, { amount: 125.5, paidDate: "2026-09-21" });
    expect(paid.status).toBe(201);
    const payment = await prisma.invoicePayment.findFirstOrThrow({ where: { invoiceId: invoice.id } });
    expect((await removePayment(invoice.id, payment.id)).status).toBe(200);
    expect(await prisma.invoicePayment.count({ where: { invoiceId: invoice.id } })).toBe(0);
  });
});

describe("V16: confirming a bank match respects the period lock of the receipt month", () => {
  it("refuses to approve a pending receipt dated in a closed month", async () => {
    const { row } = await bankRow({ date: "2026-07-10", amountCents: -4_000 });
    const receipt = await createReceipt(user.id, {
      date: "2026-07-10",
      totalAmountCents: 4_000,
      reviewStatus: "pending",
    });
    const locked = await setLock(buildRequest("PUT", "/api/period-lock", { month: "2026-07" }, { cookie }));
    expect(locked.status).toBe(200);

    const response = await confirmMatchRoute(
      buildRequest("POST", "/api/matching/confirm", { transactionId: row.id, receiptId: receipt.id }, { cookie })
    );
    expect(response.status).toBe(409);
    expect((await readJson(response)).error.code).toBe("PERIOD_LOCKED");
    expect(await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } })).toMatchObject({
      reviewStatus: "pending",
    });
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: row.id } })).receiptId).toBeNull();
  });

  it("still confirms a pending receipt of an open month", async () => {
    const { row } = await bankRow({ date: "2026-07-10", amountCents: -4_000 });
    const receipt = await createReceipt(user.id, {
      date: "2026-07-10",
      totalAmountCents: 4_000,
      reviewStatus: "pending",
    });
    const response = await confirmMatchRoute(
      buildRequest("POST", "/api/matching/confirm", { transactionId: row.id, receiptId: receipt.id }, { cookie })
    );
    expect(response.status).toBe(200);
    expect(await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } })).toMatchObject({
      reviewStatus: "approved",
    });
  });
});

describe("V40: purchase payments get the sales payment date guard", () => {
  async function payable() {
    const response = await createPurchase(
      buildRequest(
        "POST",
        "/api/purchase-invoices",
        { supplierName: "Tukku Oy", issueDate: "2026-09-15", dueDate: "2026-09-29", gross: 50, vat: 0 },
        { cookie }
      )
    );
    expect(response.status).toBe(201);
    return (await readJson(response)).invoice as { id: string };
  }
  const payPurchase = (id: string, body: Record<string, unknown>) =>
    addPurchasePayment(
      buildRequest("POST", `/api/purchase-invoices/${id}/payments`, body, { cookie }),
      routeContext({ id })
    );

  it("refuses a payment dated in the future", async () => {
    const invoice = await payable();
    const response = await payPurchase(invoice.id, { amount: 5, paidDate: "2999-01-01" });
    expect(response.status).toBe(422);
    expect((await readJson(response)).error.code).toBe("PAYMENT_IN_FUTURE");
    expect(await prisma.purchasePayment.count({ where: { purchaseInvoiceId: invoice.id } })).toBe(0);
  });

  it("refuses a payment dated before the invoice and accepts the invoice day itself", async () => {
    const invoice = await payable();
    const early = await payPurchase(invoice.id, { amount: 5, paidDate: "2026-09-01" });
    expect(early.status).toBe(422);
    const error = (await readJson(early)).error;
    expect(error.code).toBe("PAYMENT_BEFORE_INVOICE");
    expect(error.message).toContain("15.9.2026");
    expect((await payPurchase(invoice.id, { amount: 5, paidDate: "2026-09-15" })).status).toBe(201);
  });

  it("lets a bank row through whatever its date or amount", async () => {
    const invoice = await payable();
    const { row } = await bankRow({ date: "2026-09-01", amountCents: -60_00 });
    const response = await payPurchase(invoice.id, { amount: 60, paidDate: "2026-09-01", transactionId: row.id });
    expect(response.status).toBe(201);
    const stored = await prisma.purchasePayment.findFirstOrThrow({ where: { purchaseInvoiceId: invoice.id } });
    expect(stored.source).toBe("bank");
  });
});
