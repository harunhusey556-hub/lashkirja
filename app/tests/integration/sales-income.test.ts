/**
 * SALES-01: income includes the sales invoices, in every report.
 *
 * One basis for all three routes (see src/lib/alv-period.ts): invoices count
 * by invoice date from the moment they leave draft, a credit note is negative
 * in the month it is issued, and a bank row that settled an invoice is never
 * counted a second time through a receipt drafted from it.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { GET as alvReport } from "@/app/api/alv/route";
import { GET as dashboard } from "@/app/api/dashboard/route";
import { GET as profitLoss } from "@/app/api/reports/profit-loss/route";
import { POST as createCustomer } from "@/app/api/customers/route";
import { POST as createInvoice } from "@/app/api/invoices/route";
import { POST as setStatus } from "@/app/api/invoices/[id]/status/route";
import { POST as addPayment } from "@/app/api/invoices/[id]/payments/route";
import { POST as creditInvoice } from "@/app/api/invoices/[id]/credit/route";
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

async function makeInvoice(issueDate: string, unitPrice = 100, vatRate = 25.5) {
  const response = await createInvoice(
    buildRequest(
      "POST",
      "/api/invoices",
      {
        customerId,
        issueDate,
        lines: [{ description: "Ripsienpidennys", quantity: 1, unitPrice, vatRate }],
      },
      { cookie }
    )
  );
  expect(response.status).toBe(201);
  return (await readJson(response)).invoice as { id: string; gross: number };
}

async function send(id: string) {
  const response = await setStatus(
    buildRequest("POST", `/api/invoices/${id}/status`, { status: "sent" }, { cookie }),
    routeContext({ id })
  );
  expect(response.status).toBe(200);
}

async function credit(id: string): Promise<{ id: string; issueDate: string }> {
  const response = await creditInvoice(
    buildRequest("POST", `/api/invoices/${id}/credit`, {}, { cookie }),
    routeContext({ id })
  );
  expect(response.status).toBe(201);
  return (await readJson(response)).invoice;
}

async function pl(from: string, to = from) {
  const response = await profitLoss(
    buildRequest("GET", `/api/reports/profit-loss?from=${from}&to=${to}`, undefined, { cookie })
  );
  expect(response.status).toBe(200);
  return readJson(response);
}

async function front(month: string) {
  const response = await dashboard(
    buildRequest("GET", `/api/dashboard?month=${month}`, undefined, { cookie })
  );
  expect(response.status).toBe(200);
  return readJson(response);
}

async function alv(period: string) {
  const response = await alvReport(
    buildRequest("GET", `/api/alv?period=${period}`, undefined, { cookie })
  );
  expect(response.status).toBe(200);
  return readJson(response);
}

/** Sends an invoice and settles it from a bank row of the same month. */
async function payFromBank(issueDate: string, periodMonth: string) {
  const account = await createBankAccountRow(user.id, { name: "Nordea" });
  const invoice = await makeInvoice(issueDate);
  await send(invoice.id);
  const statement = await createStatementWithTransactions(user.id, {
    bankAccountId: account.id,
    periodMonth,
    transactions: [{ date: issueDate, amountCents: 125_50, counterparty: "Anna Asiakas" }],
  });
  const transactionId = statement.transactions[0].id;
  const paid = await addPayment(
    buildRequest(
      "POST",
      `/api/invoices/${invoice.id}/payments`,
      { amount: 125.5, paidDate: issueDate, transactionId },
      { cookie }
    ),
    routeContext({ id: invoice.id })
  );
  expect(paid.status).toBe(201);
  // The income automation drafts a receipt from that very bank row.
  await prisma.receipt.create({
    data: {
      userId: user.id,
      type: "tulo",
      date: new Date(`${issueDate}T00:00:00Z`),
      totalAmountCents: 125_50,
      vatDetails: VAT_255,
      sourceTransactionId: transactionId,
      reviewStatus: "approved",
      source: "auto_income",
      filePath: "/tmp/auto.pdf",
      fileName: "auto.pdf",
    },
  });
  return invoice;
}

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  const customer = await createCustomer(
    buildRequest("POST", "/api/customers", { name: "Anna Asiakas" }, { cookie })
  );
  customerId = (await readJson(customer)).customer.id as string;
});

describe("GET /api/reports/profit-loss - sales invoices are income", () => {
  it("counts a sent and a paid invoice by invoice date, with net and VAT from the lines", async () => {
    const sent = await makeInvoice("2025-03-10", 100);
    await send(sent.id);
    const paid = await makeInvoice("2025-03-20", 200);
    await send(paid.id);
    await addPayment(
      buildRequest(
        "POST",
        `/api/invoices/${paid.id}/payments`,
        { amount: 251, paidDate: "2025-04-02" },
        { cookie }
      ),
      routeContext({ id: paid.id })
    );
    await makeInvoice("2025-03-25", 999); // stays a draft: not income
    await createReceipt(user.id, {
      type: "meno",
      date: "2025-03-05",
      totalAmountCents: 62_75,
      vatDetails: JSON.stringify([{ rate: 25.5, amount: 12.75 }]),
    });

    const body = await pl("2025-03");
    expect(body.total.incomeGross).toBe(376.5);
    expect(body.total.incomeVat).toBe(76.5);
    expect(body.total.incomeNet).toBe(300);
    expect(body.total.expenseNet).toBe(50);
    expect(body.total.profitNet).toBe(250);
    expect(body.total.invoiceCount).toBe(2);
    expect(body.total.receiptCount).toBe(1);
    expect(body.total.incomeByCategory).toEqual([
      { category: "Myyntilaskut", gross: 376.5, vat: 76.5, net: 300, count: 2 },
    ]);
    expect(body.basis).toBe("laskutusperuste");
    // Paid in April, but income belongs to the invoice month.
    expect((await pl("2025-04")).total.incomeGross).toBe(0);
  });

  it("keeps a credited invoice in its month and counts the credit note negative in its own", async () => {
    const original = await makeInvoice("2025-06-10", 100);
    await send(original.id);
    const note = await credit(original.id);
    const creditMonth = note.issueDate.slice(0, 7);
    expect(creditMonth).not.toBe("2025-06");

    const june = await pl("2025-06");
    expect(june.total.incomeGross).toBe(125.5);
    expect(june.total.invoiceCount).toBe(1);

    const later = await pl(creditMonth);
    expect(later.total.incomeGross).toBe(-125.5);
    expect(later.total.incomeNet).toBe(-100);
    expect(later.total.creditNoteCount).toBe(1);
    expect(later.total.incomeByCategory[0]).toMatchObject({ category: "Hyvityslaskut", gross: -125.5 });

    // Over both months the credit cancels the invoice exactly.
    const whole = await pl("2025-06", creditMonth);
    expect(whole.total.incomeGross).toBe(0);
    expect(whole.total.incomeVat).toBe(0);
  });

  it("does not count a bank-settled invoice twice through the receipt drafted from the same row", async () => {
    await payFromBank("2025-05-12", "2025-05");
    const body = await pl("2025-05");
    expect(body.total.incomeGross).toBe(125.5);
    expect(body.total.receiptCount).toBe(0);
    expect(body.excludedReceiptCount).toBe(1);
  });

  it("never counts another user's invoices", async () => {
    const invoice = await makeInvoice("2025-03-10");
    await send(invoice.id);
    const other = await createUser();
    const otherCookie = await sessionCookie(other);
    const response = await profitLoss(
      buildRequest("GET", "/api/reports/profit-loss?from=2025-03&to=2025-03", undefined, {
        cookie: otherCookie,
      })
    );
    expect((await readJson(response)).total.incomeGross).toBe(0);
  });
});

describe("GET /api/dashboard - income includes sales invoices", () => {
  it("shows a month without a tiliote from the documents: receipts plus invoices", async () => {
    const invoice = await makeInvoice("2025-03-10", 100);
    await send(invoice.id);
    await createReceipt(user.id, {
      type: "tulo",
      date: "2025-03-12",
      totalAmountCents: 50_00,
      vatDetails: JSON.stringify([{ rate: 25.5, amount: 10.16 }]),
    });

    const body = await front("2025-03");
    expect(body.source).toBe("kuitit");
    expect(body.basis).toBe("laskutusperuste");
    expect(body.income).toBe(175.5);
    expect(body.invoiceCount).toBe(1);
    expect(body.receiptCount).toBe(1);
  });

  it("nets a credit note against income in the month it is issued", async () => {
    const original = await makeInvoice("2025-06-10", 100);
    await send(original.id);
    const note = await credit(original.id);

    expect((await front("2025-06")).income).toBe(125.5);
    const later = await front(note.issueDate.slice(0, 7));
    expect(later.income).toBe(-125.5);
  });

  it("uses the bank rows alone when the month has a tiliote, so a paid invoice counts once", async () => {
    await payFromBank("2025-05-12", "2025-05");
    const body = await front("2025-05");
    expect(body.source).toBe("tiliote");
    expect(body.basis).toBe("kassaperuste");
    expect(body.income).toBe(125.5);
  });

  it("counts invoices towards the VAT registration threshold when the year has no tiliote", async () => {
    const invoice = await makeInvoice("2025-02-10", 1000);
    await send(invoice.id);
    const body = await front("2025-03");
    // AVL 3 §: the threshold is turnover without VAT (1 000, not 1 255).
    expect(body.vat.ytdRevenue).toBe(1000);
  });
});

describe("GET /api/alv - credit notes", () => {
  it("keeps the credited invoice in its period and reduces sales VAT in the credit note's period", async () => {
    const original = await makeInvoice("2025-06-10", 100);
    await send(original.id);
    const note = await credit(original.id);

    const june = await alv("2025-06");
    expect(june.field301).toMatchObject({ netSales: 100, vat: 25.5 });
    expect(june.creditedInvoiceCount).toBe(1);
    expect(june.sources.invoiceCount).toBe(1);

    const later = await alv(note.issueDate.slice(0, 7));
    expect(later.field301).toMatchObject({ netSales: -100, vat: -25.5 });
    expect(later.creditNoteCount).toBe(1);
    expect(later.field308).toMatchObject({ amount: 25.5, isRefund: true });
  });

  it("matches the P&L income VAT and the dashboard estimate for the same month", async () => {
    const invoice = await makeInvoice("2025-03-10", 100);
    await send(invoice.id);
    const body = await alv("2025-03");
    const report = await pl("2025-03");
    expect(body.field301.vat).toBe(report.total.incomeVat);
    expect((await front("2025-03")).estimatedVat).toBe(body.field308.amount);
  });
});
