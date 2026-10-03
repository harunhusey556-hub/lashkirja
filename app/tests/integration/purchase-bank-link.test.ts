import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { POST as addSalesPayment } from "@/app/api/invoices/[id]/payments/route";
import { POST as createPurchase } from "@/app/api/purchase-invoices/route";
import {
  DELETE as deletePurchasePayment,
  POST as addPurchasePayment,
} from "@/app/api/purchase-invoices/[id]/payments/route";
import { GET as bankCandidates } from "@/app/api/purchase-invoices/[id]/payments/candidates/route";
import { GET as purchaseCandidates } from "@/app/api/matching/purchase-candidates/route";
import {
  GET as listSuggestions,
  POST as runPurchaseMatch,
} from "@/app/api/purchase-invoices/match/route";
import { POST as rejectSuggestion } from "@/app/api/purchase-invoices/match/reject/route";
import { PUT as setLock } from "@/app/api/period-lock/route";
import { GET as getStatement } from "@/app/api/statements/[id]/route";
import {
  createBankAccountRow,
  createReceipt,
  createUser,
  resetDatabase,
  type TestUser,
} from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie, type JsonValue } from "./helpers/http";

let user: TestUser;
let cookie: string;
let otherUser: TestUser;
let otherCookie: string;

// Hand-entered: no viite, no invoice number. Due 24.1.2026.
const BASE = {
  supplierName: "Tukku Oy",
  issueDate: "2026-01-10",
  dueDate: "2026-01-24",
  gross: 124,
  vat: 24,
};

async function makePurchase(body: Record<string, unknown> = {}, auth = cookie) {
  const response = await createPurchase(
    buildRequest("POST", "/api/purchase-invoices", { ...BASE, ...body }, { cookie: auth })
  );
  expect(response.status).toBe(201);
  return (await readJson(response)).invoice;
}

type RowSpec = {
  date?: string;
  amountCents: number;
  counterparty?: string | null;
  message?: string | null;
  reference?: string | null;
  receiptId?: string | null;
};

async function bankRows(owner: TestUser, rows: RowSpec[]) {
  const account = await createBankAccountRow(owner.id, { name: "Nordea" });
  const statement = await prisma.statement.create({
    data: {
      userId: owner.id,
      bankAccountId: account.id,
      fileName: "tiliote.csv",
      fileType: "csv",
      filePath: `/tmp/${Math.random()}.csv`,
      periodMonth: "2026-01",
      transactions: {
        create: rows.map((row) => ({
          date: new Date(`${row.date ?? "2026-01-25"}T00:00:00Z`),
          amountCents: row.amountCents,
          counterparty: row.counterparty === undefined ? "Tukku Oy" : row.counterparty,
          message: row.message ?? null,
          reference: row.reference ?? null,
          type: row.amountCents >= 0 ? "tulo" : "meno",
          receiptId: row.receiptId ?? null,
          matchStatus: row.receiptId ? "confirmed" : "unmatched",
        })),
      },
    },
    include: { transactions: { orderBy: { createdAt: "asc" } } },
  });
  // createMany order is not guaranteed: map back by amount + counterparty.
  return rows.map(
    (spec) =>
      statement.transactions.find(
        (row) =>
          row.amountCents === spec.amountCents &&
          row.counterparty === (spec.counterparty === undefined ? "Tukku Oy" : spec.counterparty) &&
          (row.message ?? null) === (spec.message ?? null)
      )!
  );
}

async function candidatesFor(invoiceId: string, query = "", auth = cookie) {
  const response = await bankCandidates(
    buildRequest("GET", `/api/purchase-invoices/${invoiceId}/payments/candidates${query}`, undefined, {
      cookie: auth,
    }),
    routeContext({ id: invoiceId })
  );
  return { status: response.status, body: await readJson(response) };
}

async function invoicesFor(transactionId: string, query = "", auth = cookie) {
  const response = await purchaseCandidates(
    buildRequest(
      "GET",
      `/api/matching/purchase-candidates?transactionId=${transactionId}${query}`,
      undefined,
      { cookie: auth }
    )
  );
  return { status: response.status, body: await readJson(response) };
}

async function link(invoiceId: string, body: Record<string, unknown>) {
  const response = await addPurchasePayment(
    buildRequest("POST", `/api/purchase-invoices/${invoiceId}/payments`, body, { cookie }),
    routeContext({ id: invoiceId })
  );
  return { status: response.status, body: await readJson(response) };
}

const ids = (body: JsonValue) => body.candidates.map((c: JsonValue) => c.transactionId);

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  otherUser = await createUser();
  otherCookie = await sessionCookie(otherUser);
});

describe("GET /api/purchase-invoices/[id]/payments/candidates", () => {
  it("ranks the exact amount from the supplier first, a fee difference next, and flags the difference", async () => {
    const invoice = await makePurchase();
    const [exact, amountOnly, nameOnly, withFee] = await bankRows(user, [
      { amountCents: -124_00 },
      { amountCents: -124_00, counterparty: "Joku Muu" },
      { amountCents: -50_00 },
      { amountCents: -126_00 },
    ]);

    const { status, body } = await candidatesFor(invoice.id);
    expect(status).toBe(200);
    expect(ids(body).slice(0, 4)).toEqual([exact.id, withFee.id, amountOnly.id, nameOnly.id]);

    const top = body.candidates[0];
    expect(top).toMatchObject({ amount: 124, counterparty: "Tukku Oy", date: "2026-01-25", exactAmount: true, amountDiff: null });
    expect(top.reasons).toEqual(expect.arrayContaining(["summa sama", "nimi vastaa"]));
    expect(top.score).toBeGreaterThanOrEqual(0.7);

    const fee = body.candidates[1];
    expect(fee.exactAmount).toBe(false);
    expect(fee.amountDiff).toBe(2);
    expect(fee.reasons).toEqual(expect.arrayContaining(["nimi vastaa"]));
    expect(fee.reasons.some((reason: string) => /^summa poikkeaa 2,00\s€$/u.test(reason))).toBe(true);
    expect(fee.score).toBeLessThan(top.score);
  });

  it("finds the payment of an invoice that has no viite and no number", async () => {
    const invoice = await makePurchase({ reference: null, invoiceNumber: null });
    const [row] = await bankRows(user, [{ amountCents: -124_00, counterparty: "TUKKU OY HELSINKI", date: "2026-02-03" }]);
    const { body } = await candidatesFor(invoice.id);
    expect(ids(body)[0]).toBe(row.id);
    expect(body.candidates[0].reasons).toEqual(
      expect.arrayContaining(["summa sama", "nimi vastaa", "maksettu 10 päivää eräpäivän jälkeen"])
    );
  });

  it("gives a viite or the invoice number in the message as a reason", async () => {
    const invoice = await makePurchase({ invoiceNumber: "88123" });
    const [row] = await bankRows(user, [{ amountCents: -124_00, counterparty: "Maksu", message: "Lasku 88123" }]);
    const { body } = await candidatesFor(invoice.id);
    expect(ids(body)[0]).toBe(row.id);
    expect(body.candidates[0].reasons).toEqual(expect.arrayContaining(["viite täsmää", "summa sama"]));
  });

  it("leaves out another owner's rows, incoming money and rows already in use", async () => {
    const invoice = await makePurchase();
    const other = await makePurchase();
    await bankRows(otherUser, [{ amountCents: -124_00 }]);
    const receipt = await createReceipt(user.id, { date: "2026-01-25", totalAmountCents: 124_00 });
    const [free, incoming, used, withReceipt] = await bankRows(user, [
      { amountCents: -124_00 },
      { amountCents: 124_00 },
      { amountCents: -124_00, message: "toinen" },
      { amountCents: -124_00, message: "kuitilla", receiptId: receipt.id },
    ]);
    expect((await link(other.id, { amount: 124, paidDate: "2026-01-25", transactionId: used.id })).status).toBe(201);

    const { body } = await candidatesFor(invoice.id);
    expect(ids(body)).toEqual([free.id]);
    expect(ids(body)).not.toContain(incoming.id);
    expect(ids(body)).not.toContain(withReceipt.id);
  });

  it("offers a row whose receipt is this invoice's own receipt", async () => {
    const receipt = await createReceipt(user.id, { date: "2026-01-12", totalAmountCents: 124_00 });
    const invoice = await makePurchase({ receiptId: receipt.id });
    const [row] = await bankRows(user, [{ amountCents: -124_00, receiptId: receipt.id }]);
    const { body } = await candidatesFor(invoice.id);
    expect(ids(body)).toEqual([row.id]);
  });

  it("searches counterparty, message and amount, and narrows to a month", async () => {
    const invoice = await makePurchase();
    const [a, b, c] = await bankRows(user, [
      { amountCents: -124_00, counterparty: "Joku Muu" },
      { amountCents: -987_65, counterparty: "Vuokranantaja", message: "Vuokra tammikuu" },
      { amountCents: -10_00, counterparty: "Kahvila", date: "2026-03-02" },
    ]);
    expect(ids((await candidatesFor(invoice.id, "?q=joku")).body)).toEqual([a.id]);
    expect(ids((await candidatesFor(invoice.id, "?q=vuokra")).body)).toEqual([b.id]);
    expect(ids((await candidatesFor(invoice.id, "?q=987,65")).body)).toEqual([b.id]);
    const march = (await candidatesFor(invoice.id, "?month=2026-03")).body;
    expect(ids(march)).toEqual([c.id]);
    expect(march.months).toEqual(
      expect.arrayContaining([
        { month: "2026-01", count: 2 },
        { month: "2026-03", count: 1 },
      ])
    );
    expect((await candidatesFor(invoice.id, "?month=2026-13")).status).toBe(400);
  });

  it("caps the list at 30 rows", async () => {
    const invoice = await makePurchase();
    await bankRows(
      user,
      Array.from({ length: 35 }, (_, index) => ({ amountCents: -(1_00 + index), counterparty: `Kauppa ${index}` }))
    );
    const { body } = await candidatesFor(invoice.id, "?q=kauppa");
    expect(body.candidates).toHaveLength(30);
    expect(body.total).toBe(35);
  });

  it("404s on another owner's invoice", async () => {
    const foreign = await makePurchase({}, otherCookie);
    expect((await candidatesFor(foreign.id)).status).toBe(404);
  });
});

describe("linking a bank row to a purchase invoice", () => {
  it("pays the invoice from the row, and a partial row leaves it open", async () => {
    const full = await makePurchase();
    const part = await makePurchase({ gross: 300, vat: 0 });
    const [row, partial] = await bankRows(user, [
      { amountCents: -124_00 },
      { amountCents: -100_00, message: "osamaksu" },
    ]);

    const paid = await link(full.id, { amount: 124, paidDate: "2026-01-25", transactionId: row.id });
    expect(paid.status).toBe(201);
    expect(paid.body.invoice).toMatchObject({ status: "paid", open: 0 });
    expect(paid.body.invoice.payments[0]).toMatchObject({
      source: "bank",
      transactionId: row.id,
      transaction: { id: row.id, counterparty: "Tukku Oy", date: "2026-01-25", amount: -124 },
    });

    const open = await link(part.id, { amount: 100, paidDate: "2026-01-25", transactionId: partial.id });
    expect(open.status).toBe(201);
    expect(open.body.invoice).toMatchObject({ status: "open", paid: 100, open: 200 });
  });

  it("refuses a row already in use with 409, incoming money and more than the row paid", async () => {
    const first = await makePurchase();
    const second = await makePurchase();
    const [row, incoming] = await bankRows(user, [{ amountCents: -124_00 }, { amountCents: 124_00 }]);
    expect((await link(first.id, { amount: 124, paidDate: "2026-01-25", transactionId: row.id })).status).toBe(201);

    const reused = await link(second.id, { amount: 124, paidDate: "2026-01-25", transactionId: row.id });
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("TRANSACTION_ALREADY_USED");

    const wrongWay = await link(second.id, { amount: 124, paidDate: "2026-01-25", transactionId: incoming.id });
    expect(wrongWay.status).toBe(422);
    expect(wrongWay.body.error.code).toBe("TRANSACTION_NOT_OUTGOING");

    const [small] = await bankRows(user, [{ amountCents: -20_00, message: "pieni" }]);
    const tooMuch = await link(second.id, { amount: 124, paidDate: "2026-01-25", transactionId: small.id });
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.error.code).toBe("PAYMENT_EXCEEDS_TRANSACTION");
    expect(await prisma.purchasePayment.count()).toBe(1);
  });

  it("refuses another owner's row", async () => {
    const invoice = await makePurchase();
    const [foreign] = await bankRows(otherUser, [{ amountCents: -124_00 }]);
    expect((await link(invoice.id, { amount: 124, paidDate: "2026-01-25", transactionId: foreign.id })).status).toBe(404);
  });

  it("respects a closed period", async () => {
    const invoice = await makePurchase();
    const [row] = await bankRows(user, [{ amountCents: -124_00 }]);
    const locked = await setLock(buildRequest("PUT", "/api/period-lock", { month: "2026-01" }, { cookie }));
    expect(locked.status).toBe(200);
    const result = await link(invoice.id, { amount: 124, paidDate: "2026-01-25", transactionId: row.id });
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe("PERIOD_LOCKED");
  });

  it("unlinking frees the row: it is offered again and can pay another invoice", async () => {
    const invoice = await makePurchase();
    const other = await makePurchase();
    const [row] = await bankRows(user, [{ amountCents: -124_00 }]);
    const linked = await link(invoice.id, { amount: 124, paidDate: "2026-01-25", transactionId: row.id });
    expect(ids((await candidatesFor(other.id)).body)).not.toContain(row.id);

    const removed = await deletePurchasePayment(
      buildRequest(
        "DELETE",
        `/api/purchase-invoices/${invoice.id}/payments?paymentId=${linked.body.invoice.payments[0].id}`,
        undefined,
        { cookie }
      ),
      routeContext({ id: invoice.id })
    );
    expect(removed.status).toBe(200);
    expect((await readJson(removed)).invoice).toMatchObject({ status: "open", open: 124 });
    expect(ids((await candidatesFor(other.id)).body)).toContain(row.id);
    expect((await link(other.id, { amount: 124, paidDate: "2026-01-25", transactionId: row.id })).status).toBe(201);
  });

  it("tells the bank feed which purchase invoice the row paid", async () => {
    const invoice = await makePurchase();
    const [row] = await bankRows(user, [{ amountCents: -124_00 }]);
    const linked = await link(invoice.id, { amount: 124, paidDate: "2026-01-25", transactionId: row.id });
    const response = await getStatement(
      buildRequest("GET", `/api/statements/${row.statementId}`, undefined, { cookie }),
      routeContext({ id: row.statementId })
    );
    const statement = (await readJson(response)).statement;
    const fresh = statement.transactions.find((t: JsonValue) => t.id === row.id);
    expect(fresh.settlesPurchase).toBe(true);
    expect(fresh.paidPurchase).toEqual({
      id: invoice.id,
      supplierName: "Tukku Oy",
      paymentId: linked.body.invoice.payments[0].id,
    });
  });
});

describe("GET /api/matching/purchase-candidates", () => {
  it("ranks open purchase invoices for one outgoing row", async () => {
    const right = await makePurchase();
    const wrongName = await makePurchase({ supplierName: "Sähkö Oy" });
    const near = await makePurchase({ gross: 122, vat: 0 });
    const paid = await makePurchase();
    await makePurchase({}, otherCookie);
    const [row, payRow] = await bankRows(user, [{ amountCents: -124_00 }, { amountCents: -124_00, message: "maksettu" }]);
    expect((await link(paid.id, { amount: 124, paidDate: "2026-01-25", transactionId: payRow.id })).status).toBe(201);

    const { status, body } = await invoicesFor(row.id);
    expect(status).toBe(200);
    const order = body.candidates.map((c: JsonValue) => c.invoice.id);
    expect(order[0]).toBe(right.id);
    expect(order).toEqual(expect.arrayContaining([wrongName.id, near.id]));
    expect(order).not.toContain(paid.id);
    expect(order).toHaveLength(3);
    expect(order.indexOf(near.id)).toBeLessThan(order.indexOf(wrongName.id));
    expect(body.candidates[0].reasons).toEqual(expect.arrayContaining(["summa sama", "nimi vastaa"]));
    expect(body.candidates[0].invoice).toMatchObject({ supplierName: "Tukku Oy", open: 124, dueDate: "2026-01-24" });
    const nearHit = body.candidates.find((c: JsonValue) => c.invoice.id === near.id);
    expect(nearHit.amountDiff).toBe(2);

    expect((await invoicesFor(row.id, "&q=s%C3%A4hk%C3%B6")).body.candidates.map((c: JsonValue) => c.invoice.id)).toEqual([
      wrongName.id,
    ]);
  });

  it("refuses incoming, used and foreign rows", async () => {
    const invoice = await makePurchase();
    const [incoming, used] = await bankRows(user, [{ amountCents: 50_00 }, { amountCents: -124_00 }]);
    const [foreign] = await bankRows(otherUser, [{ amountCents: -124_00 }]);
    await link(invoice.id, { amount: 124, paidDate: "2026-01-25", transactionId: used.id });

    expect((await invoicesFor(incoming.id)).status).toBe(400);
    const taken = await invoicesFor(used.id);
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe("TRANSACTION_ALREADY_USED");
    expect((await invoicesFor(foreign.id)).status).toBe(404);
    expect(
      (await purchaseCandidates(buildRequest("GET", "/api/matching/purchase-candidates", undefined, { cookie }))).status
    ).toBe(400);
  });
});

describe("purchase match suggestions", () => {
  it("lists suggestions without writing, accepts one through the payment route and forgets a rejected one", async () => {
    const accepted = await makePurchase();
    const rejected = await makePurchase({ supplierName: "Sähkö Oy", gross: 80, vat: 0 });
    const [row, other] = await bankRows(user, [
      { amountCents: -124_00 },
      { amountCents: -80_00, counterparty: "Sähkö Oy" },
    ]);

    const listed = await readJson(
      await listSuggestions(buildRequest("GET", "/api/purchase-invoices/match", undefined, { cookie }))
    );
    expect(listed.suggestions).toHaveLength(2);
    const first = listed.suggestions.find((s: JsonValue) => s.invoiceId === accepted.id);
    expect(first).toMatchObject({
      transactionId: row.id,
      amount: 124,
      paidDate: "2026-01-25",
      counterparty: "Tukku Oy",
      open: 124,
    });
    expect(first.reasons).toEqual(expect.arrayContaining(["summa sama", "nimi vastaa"]));
    expect(await prisma.purchasePayment.count()).toBe(0);

    // Hyväksy: the payment route with the suggestion's row.
    expect(
      (await link(accepted.id, { amount: first.amount, paidDate: first.paidDate, transactionId: first.transactionId })).status
    ).toBe(201);

    // Hylkää: remembered, the pair is not suggested again (by GET or by the POST run).
    const response = await rejectSuggestion(
      buildRequest(
        "POST",
        "/api/purchase-invoices/match/reject",
        { invoiceId: rejected.id, transactionId: other.id },
        { cookie }
      )
    );
    expect(response.status).toBe(200);
    const again = await readJson(
      await listSuggestions(buildRequest("GET", "/api/purchase-invoices/match", undefined, { cookie }))
    );
    expect(again.suggestions).toEqual([]);
    const run = await readJson(
      await runPurchaseMatch(buildRequest("POST", "/api/purchase-invoices/match", undefined, { cookie }))
    );
    expect(run.suggestions).toEqual([]);

    // The owner can still pick the rejected row by hand.
    expect(ids((await candidatesFor(rejected.id)).body)).toContain(other.id);
  });

  it("refuses to reject another owner's pair", async () => {
    const invoice = await makePurchase({}, otherCookie);
    const [row] = await bankRows(otherUser, [{ amountCents: -124_00 }]);
    const response = await rejectSuggestion(
      buildRequest(
        "POST",
        "/api/purchase-invoices/match/reject",
        { invoiceId: invoice.id, transactionId: row.id },
        { cookie }
      )
    );
    expect(response.status).toBe(404);
    expect(await prisma.automationEvent.count()).toBe(0);
  });
});

describe("one bank row pays one invoice, sales or purchase", () => {
  async function sentSalesInvoice() {
    const customer = await prisma.customer.create({ data: { userId: user.id, name: "Anna Asiakas" } });
    return prisma.salesInvoice.create({
      data: {
        userId: user.id,
        customerId: customer.id,
        number: 900 + Math.floor(Math.random() * 1000),
        reference: "1232",
        issueDate: new Date("2026-01-10T00:00:00Z"),
        dueDate: new Date("2026-01-24T00:00:00Z"),
        status: "sent",
        grossCents: 124_00,
        netCents: 98_80,
        vatCents: 25_20,
      },
    });
  }

  async function paySales(invoiceId: string, transactionId: string) {
    const response = await addSalesPayment(
      buildRequest("POST", `/api/invoices/${invoiceId}/payments`, { amount: 124, paidDate: "2026-01-25", transactionId }, { cookie }),
      routeContext({ id: invoiceId })
    );
    return { status: response.status, body: await readJson(response) };
  }

  it("a row that paid a purchase invoice cannot also pay a sales invoice", async () => {
    const purchase = await makePurchase();
    const sales = await sentSalesInvoice();
    const [row] = await bankRows(user, [{ amountCents: -124_00 }]);
    expect((await link(purchase.id, { amount: 124, paidDate: "2026-01-25", transactionId: row.id })).status).toBe(201);

    const result = await paySales(sales.id, row.id);
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe("TRANSACTION_ALREADY_USED");
    expect(await prisma.invoicePayment.count({ where: { invoiceId: sales.id } })).toBe(0);
  });

  it("a row that paid a sales invoice cannot also pay a purchase invoice", async () => {
    const purchase = await makePurchase();
    const sales = await sentSalesInvoice();
    const [row] = await bankRows(user, [{ amountCents: -124_00 }]);
    expect((await paySales(sales.id, row.id)).status).toBe(201);

    const result = await link(purchase.id, { amount: 124, paidDate: "2026-01-25", transactionId: row.id });
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe("TRANSACTION_ALREADY_USED");
    expect(await prisma.purchasePayment.count({ where: { purchaseInvoiceId: purchase.id } })).toBe(0);
  });
});
