import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { GET as alvReport } from "@/app/api/alv/route";
import { POST as createCustomer } from "@/app/api/customers/route";
import { POST as createInvoice } from "@/app/api/invoices/route";
import { POST as setStatus } from "@/app/api/invoices/[id]/status/route";
import { POST as addPayment } from "@/app/api/invoices/[id]/payments/route";
import { PATCH as reviewReceipt } from "@/app/api/receipts/[id]/review/route";
import { DELETE as deleteStatement, GET as getStatement } from "@/app/api/statements/[id]/route";
import {
  DELETE as deleteRow,
  PATCH as patchRow,
} from "@/app/api/statements/[id]/transactions/route";
import { POST as ignoreRow } from "@/app/api/matching/ignore/route";
import { PUT as setLock } from "@/app/api/period-lock/route";
import { autoGenerateIncomeReceipts } from "@/lib/income-automation";
import {
  createBankAccountRow,
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

async function saleFixture(opts: { rows?: number } = {}) {
  const account = await createBankAccountRow(user.id, { name: "Nordea" });
  const statement = await createStatementWithTransactions(user.id, {
    bankAccountId: account.id,
    periodMonth: "2026-09",
    transactions: Array.from({ length: opts.rows ?? 1 }, (_, index) => ({
      date: `2026-09-${String(20 + index).padStart(2, "0")}`,
      amountCents: 125_50,
      counterparty: "Asiakas Oy",
    })),
  });
  return { account, statement };
}

async function sentInvoice() {
  const created = await createInvoice(
    buildRequest(
      "POST",
      "/api/invoices",
      {
        customerId,
        issueDate: "2026-09-20",
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

/** The exact scenario of F05/G15: invoice paid via a bank row, then its draft approved. */
async function paidSaleWithApprovedDraft() {
  const { statement } = await saleFixture();
  const row = statement.transactions[0];
  const invoice = await sentInvoice();
  await autoGenerateIncomeReceipts(user.id, statement.id);
  const draft = await prisma.receipt.findFirstOrThrow({ where: { sourceTransactionId: row.id } });
  // A VAT-registered profile drafts the VAT split with the draft (income-automation).
  await prisma.receipt.update({ where: { id: draft.id }, data: { vatDetails: VAT_255 } });
  const paid = await addPayment(
    buildRequest(
      "POST",
      `/api/invoices/${invoice.id}/payments`,
      { amount: 125.5, paidDate: "2026-09-20", transactionId: row.id },
      { cookie }
    ),
    routeContext({ id: invoice.id })
  );
  expect(paid.status).toBe(201);
  const approved = await reviewReceipt(
    buildRequest("PATCH", `/api/receipts/${draft.id}/review`, { reviewStatus: "approved" }, { cookie }),
    routeContext({ id: draft.id })
  );
  expect(approved.status).toBe(200);
  return { statement, row, invoice, draft };
}

async function report() {
  const response = await alvReport(buildRequest("GET", "/api/alv?period=2026-09", undefined, { cookie }));
  expect(response.status).toBe(200);
  return readJson(response);
}

function figures(body: Awaited<ReturnType<typeof report>>) {
  return {
    field301: body.field301,
    field302: body.field302,
    field303: body.field303,
    field309: body.field309,
    field308: body.field308,
  };
}

function removeRow(statementId: string, transactionId: string) {
  return deleteRow(
    buildRequest("DELETE", `/api/statements/${statementId}/transactions`, { transactionId }, { cookie }),
    routeContext({ id: statementId })
  );
}

function removeStatement(statementId: string) {
  return deleteStatement(
    buildRequest("DELETE", `/api/statements/${statementId}`, undefined, { cookie }),
    routeContext({ id: statementId })
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

describe("a sale that a bank row settled is counted once, whatever happens to the row", () => {
  it("baseline: while the row exists the draft is left out of the return", async () => {
    await paidSaleWithApprovedDraft();
    const body = await report();
    expect(body.field301).toMatchObject({ netSales: 100, vat: 25.5 });
    expect(body.excludedReceiptCount).toBe(1);
  });

  it("F05: deleting the bank row does not add the sale a second time", async () => {
    const { statement, row } = await paidSaleWithApprovedDraft();
    const before = figures(await report());

    const response = await removeRow(statement.id, row.id);
    expect(response.status).toBe(200);

    const after = await report();
    expect(figures(after)).toEqual(before);
    expect(after.receiptCount).toBe(0);
    // The invoice stays paid: losing the bank row does not erase the payment.
    const payments = await prisma.invoicePayment.findMany();
    expect(payments).toHaveLength(1);
    expect(payments[0].transactionId).toBeNull();
  });

  it("G15: deleting the whole statement does not add the sale a second time", async () => {
    const { statement } = await paidSaleWithApprovedDraft();
    const before = figures(await report());

    const response = await removeStatement(statement.id);
    expect(response.status).toBe(200);

    const after = await report();
    expect(figures(after)).toEqual(before);
    expect(after.receiptCount).toBe(0);
  });

  it("F05: row delete then statement delete, in that order, still counts the sale once", async () => {
    const { statement, row } = await paidSaleWithApprovedDraft();
    const before = figures(await report());
    expect((await removeRow(statement.id, row.id)).status).toBe(200);
    expect((await removeStatement(statement.id)).status).toBe(200);
    expect(figures(await report())).toEqual(before);
  });

  it("keeps an approved draft that settled no invoice: that is the only record of the sale", async () => {
    const { statement } = await saleFixture();
    await autoGenerateIncomeReceipts(user.id, statement.id);
    const draft = await prisma.receipt.findFirstOrThrow({ where: { source: "auto_income" } });
    await prisma.receipt.update({ where: { id: draft.id }, data: { vatDetails: VAT_255 } });
    await reviewReceipt(
      buildRequest("PATCH", `/api/receipts/${draft.id}/review`, { reviewStatus: "approved" }, { cookie }),
      routeContext({ id: draft.id })
    );
    const before = figures(await report());
    expect((await removeStatement(statement.id)).status).toBe(200);
    expect(await prisma.receipt.findUnique({ where: { id: draft.id } })).toMatchObject({
      reviewStatus: "approved",
    });
    expect(figures(await report())).toEqual(before);
  });
});

describe("F49/G17: pending sale drafts go with their bank row", () => {
  it("deleting a statement removes its pending drafts and only those", async () => {
    const { statement } = await saleFixture({ rows: 3 });
    await autoGenerateIncomeReceipts(user.id, statement.id);
    const drafts = await prisma.receipt.findMany({ where: { source: "auto_income" } });
    expect(drafts).toHaveLength(3);
    // One was approved before: it is booked evidence and stays.
    await prisma.receipt.update({ where: { id: drafts[0].id }, data: { reviewStatus: "approved" } });
    // A draft from another statement is not touched.
    const other = await saleFixture();
    await autoGenerateIncomeReceipts(user.id, other.statement.id);

    const response = await removeStatement(statement.id);
    expect(response.status).toBe(200);
    expect((await readJson(response)).removedDrafts).toBe(2);

    const left = await prisma.receipt.findMany({ where: { source: "auto_income" } });
    expect(left.map((r) => r.id).sort()).toEqual(
      [
        drafts[0].id,
        (await prisma.receipt.findFirstOrThrow({
          where: { sourceTransactionId: other.statement.transactions[0].id },
        })).id,
      ].sort()
    );
    expect(left.filter((r) => r.reviewStatus === "pending")).toHaveLength(1);
  });

  it("deleting one bank row removes that row's pending draft", async () => {
    const { statement } = await saleFixture({ rows: 2 });
    await autoGenerateIncomeReceipts(user.id, statement.id);
    const [first, second] = statement.transactions;

    expect((await removeRow(statement.id, first.id)).status).toBe(200);

    const left = await prisma.receipt.findMany({ where: { source: "auto_income" } });
    expect(left.map((r) => r.sourceTransactionId)).toEqual([second.id]);
  });
});

describe("G16: bank row edit, delete and ignore honour the period lock", () => {
  async function lock() {
    const response = await setLock(buildRequest("PUT", "/api/period-lock", { month: "2026-09" }, { cookie }));
    expect(response.status).toBe(200);
  }

  it("refuses to edit a row of a locked month", async () => {
    const { statement } = await saleFixture();
    await lock();
    const response = await patchRow(
      buildRequest(
        "PATCH",
        `/api/statements/${statement.id}/transactions`,
        { transactionId: statement.transactions[0].id, amount: -80 },
        { cookie }
      ),
      routeContext({ id: statement.id })
    );
    expect(response.status).toBe(409);
    expect((await readJson(response)).error.code).toBe("PERIOD_LOCKED");
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: statement.transactions[0].id } })).amountCents).toBe(125_50);
  });

  it("refuses to move a row into a locked month", async () => {
    const account = await createBankAccountRow(user.id, { name: "Nordea" });
    const statement = await createStatementWithTransactions(user.id, {
      bankAccountId: account.id,
      periodMonth: "2026-10",
      transactions: [{ date: "2026-10-05", amountCents: -1000 }],
    });
    await lock();
    const response = await patchRow(
      buildRequest(
        "PATCH",
        `/api/statements/${statement.id}/transactions`,
        { transactionId: statement.transactions[0].id, date: "2026-09-28" },
        { cookie }
      ),
      routeContext({ id: statement.id })
    );
    expect(response.status).toBe(409);
  });

  it("refuses to delete a row of a locked month and leaves everything as it was", async () => {
    const { statement, row } = await paidSaleWithApprovedDraft();
    await lock();
    const before = figures(await report());
    const response = await removeRow(statement.id, row.id);
    expect(response.status).toBe(409);
    expect((await readJson(response)).error.code).toBe("PERIOD_LOCKED");
    expect(await prisma.transaction.count()).toBe(1);
    expect(figures(await report())).toEqual(before);
  });

  it("refuses to ignore a row of a locked month", async () => {
    const { statement } = await saleFixture();
    await lock();
    const response = await ignoreRow(
      buildRequest("POST", "/api/matching/ignore", { transactionId: statement.transactions[0].id }, { cookie })
    );
    expect(response.status).toBe(409);
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: statement.transactions[0].id } })).matchStatus).toBe("unmatched");
  });

  it("still lets an open month's rows be changed", async () => {
    const account = await createBankAccountRow(user.id, { name: "Nordea" });
    const statement = await createStatementWithTransactions(user.id, {
      bankAccountId: account.id,
      periodMonth: "2026-10",
      transactions: [{ date: "2026-10-05", amountCents: -1000 }],
    });
    await lock();
    const response = await patchRow(
      buildRequest(
        "PATCH",
        `/api/statements/${statement.id}/transactions`,
        { transactionId: statement.transactions[0].id, amount: -1200 },
        { cookie }
      ),
      routeContext({ id: statement.id })
    );
    expect(response.status).toBe(200);
  });
});

describe("V19 V24: the statement tells which rows paid an invoice, for an honest delete dialog", () => {
  it("flags only the row that settled an invoice", async () => {
    const { statement, row } = await paidSaleWithApprovedDraft();
    const other = await prisma.transaction.create({
      data: { statementId: statement.id, userId: user.id, date: new Date("2026-09-21T00:00:00.000Z"), amountCents: -500, counterparty: "Kioski", type: "meno" },
    });
    const response = await getStatement(
      buildRequest("GET", `/api/statements/${statement.id}`, undefined, { cookie }),
      routeContext({ id: statement.id })
    );
    const rows = (await readJson(response)).statement.transactions as Array<{ id: string; settlesInvoice: boolean; invoicePayment?: unknown }>;
    expect(rows.find((tx) => tx.id === row.id)?.settlesInvoice).toBe(true);
    expect(rows.find((tx) => tx.id === other.id)?.settlesInvoice).toBe(false);
    expect(rows.every((tx) => tx.invoicePayment === undefined)).toBe(true);
  });
});
