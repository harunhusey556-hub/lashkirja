import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { GET as listInvoices, POST as createInvoice } from "@/app/api/invoices/route";
import {
  DELETE as deleteInvoice,
  GET as getInvoice,
  PATCH as patchInvoice,
} from "@/app/api/invoices/[id]/route";
import { POST as setStatus } from "@/app/api/invoices/[id]/status/route";
import {
  DELETE as deletePayment,
  POST as addPayment,
} from "@/app/api/invoices/[id]/payments/route";
import { POST as runMatch } from "@/app/api/invoices/match/route";
import { POST as createCustomer } from "@/app/api/customers/route";
import { isValidReferenceNumber } from "@/lib/finnish-reference";
import {
  createBankAccountRow,
  createStatementWithTransactions,
  createUser,
  resetDatabase,
  type TestUser,
} from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie, type JsonValue } from "./helpers/http";

let user: TestUser;
let cookie: string;
let otherUser: TestUser;
let otherCookie: string;
let customerId: string;

const LINE = { description: "Ripsienpidennys", quantity: 1, unitPrice: 100, vatRate: 25.5 };

async function makeCustomer(auth = cookie, overrides: Record<string, unknown> = {}) {
  const response = await createCustomer(
    buildRequest("POST", "/api/customers", { name: "Anna Asiakas", ...overrides }, { cookie: auth })
  );
  return (await readJson(response)).customer;
}

async function postInvoice(body: Record<string, unknown> = {}, auth = cookie) {
  return createInvoice(
    buildRequest(
      "POST",
      "/api/invoices",
      {
        customerId,
        issueDate: "2026-01-10",
        lines: [LINE],
        ...body,
      },
      { cookie: auth }
    )
  );
}

async function makeInvoice(body: Record<string, unknown> = {}) {
  const response = await postInvoice(body);
  expect(response.status).toBe(201);
  return (await readJson(response)).invoice;
}

async function send(invoiceId: string) {
  const response = await setStatus(
    buildRequest("POST", `/api/invoices/${invoiceId}/status`, { status: "sent" }, { cookie }),
    routeContext({ id: invoiceId })
  );
  expect(response.status).toBe(200);
  return (await readJson(response)).invoice;
}

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  otherUser = await createUser();
  otherCookie = await sessionCookie(otherUser);
  customerId = (await makeCustomer()).id;
});

describe("POST /api/invoices", () => {
  it("numbers invoices per user starting from one", async () => {
    expect((await makeInvoice()).number).toBe(1);
    expect((await makeInvoice()).number).toBe(2);

    const foreignCustomer = await makeCustomer(otherCookie, { name: "Toisen asiakas" });
    const foreign = await readJson(
      await createInvoice(
        buildRequest(
          "POST",
          "/api/invoices",
          { customerId: foreignCustomer.id, issueDate: "2026-01-10", lines: [LINE] },
          { cookie: otherCookie }
        )
      )
    );
    expect(foreign.invoice.number).toBe(1);
  });

  it("gives every invoice a valid, unique reference number", async () => {
    const references = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const invoice = await makeInvoice();
      expect(isValidReferenceNumber(invoice.reference)).toBe(true);
      references.add(invoice.reference);
    }
    expect(references.size).toBe(5);
  });

  it("computes totals from the lines", async () => {
    const invoice = await makeInvoice({
      lines: [
        { description: "Pidennys", quantity: 2, unitPrice: 80, vatRate: 25.5 },
        { description: "Tuote", quantity: 1, unitPrice: 20, vatRate: 14 },
      ],
    });
    expect(invoice.net).toBe(180);
    expect(invoice.vat).toBe(43.6); // 40,80 (25,5 %) + 2,80 (14 %)
    expect(invoice.gross).toBe(223.6);
    expect(invoice.open).toBe(223.6);
    expect(invoice.paid).toBe(0);
    expect(invoice.lines).toHaveLength(2);
    expect(invoice.lines[0]).toMatchObject({ quantity: 2, unitPrice: 80, vatRate: 25.5, net: 160 });
  });

  it("derives the due date from the customer's payment term", async () => {
    const slowPayer = await makeCustomer(cookie, { name: "Hidas", defaultPaymentTermDays: 30 });
    const invoice = await makeInvoice({ customerId: slowPayer.id });
    expect(invoice.dueDate).toBe("2026-02-09");
  });

  it("accepts an explicit term and an explicit due date", async () => {
    expect((await makeInvoice({ paymentTermDays: 7 })).dueDate).toBe("2026-01-17");
    expect((await makeInvoice({ dueDate: "2026-03-01" })).dueDate).toBe("2026-03-01");
  });

  it("refuses a due date before the invoice date", async () => {
    const response = await postInvoice({ dueDate: "2026-01-09" });
    expect(response.status).toBe(400);
    expect(await prisma.salesInvoice.count()).toBe(0);
  });

  it("refuses fractional quantities beyond three decimals and unknown VAT rates", async () => {
    expect((await postInvoice({ lines: [{ ...LINE, quantity: 1.00005 }] })).status).toBe(400);
    expect((await postInvoice({ lines: [{ ...LINE, vatRate: 24 }] })).status).toBe(400);
    expect((await postInvoice({ lines: [{ ...LINE, quantity: 0 }] })).status).toBe(400);
  });

  it("refuses an empty line list and a missing description", async () => {
    expect((await postInvoice({ lines: [] })).status).toBe(400);
    expect((await postInvoice({ lines: [{ ...LINE, description: "  " }] })).status).toBe(400);
  });

  it("refuses another user's customer and an archived one", async () => {
    const foreignCustomer = await makeCustomer(otherCookie, { name: "Toisen" });
    expect((await postInvoice({ customerId: foreignCustomer.id })).status).toBe(404);

    await prisma.customer.update({
      where: { id: customerId },
      data: { archivedAt: new Date() },
    });
    const archived = await postInvoice();
    expect(archived.status).toBe(409);
    expect((await readJson(archived)).error.code).toBe("CUSTOMER_ARCHIVED");
  });
});

describe("PATCH / DELETE /api/invoices/[id]", () => {
  it("rewrites a draft's lines and recomputes the totals", async () => {
    const invoice = await makeInvoice();
    const response = await patchInvoice(
      buildRequest(
        "PATCH",
        `/api/invoices/${invoice.id}`,
        { lines: [{ description: "Uusi rivi", quantity: 3, unitPrice: 10, vatRate: 25.5 }] },
        { cookie }
      ),
      routeContext({ id: invoice.id })
    );
    const updated = (await readJson(response)).invoice;
    expect(updated.lines).toHaveLength(1);
    expect(updated.net).toBe(30);
    expect(updated.gross).toBe(37.65);
    // The replaced lines must not linger in the table.
    expect(await prisma.invoiceLine.count({ where: { invoiceId: invoice.id } })).toBe(1);
  });

  it("freezes a sent invoice's content but still allows notes and a new due date", async () => {
    const invoice = await makeInvoice();
    await send(invoice.id);

    const locked = await patchInvoice(
      buildRequest("PATCH", `/api/invoices/${invoice.id}`, { lines: [LINE] }, { cookie }),
      routeContext({ id: invoice.id })
    );
    expect(locked.status).toBe(409);
    expect((await readJson(locked)).error.code).toBe("INVOICE_LOCKED");

    const allowed = await patchInvoice(
      buildRequest(
        "PATCH",
        `/api/invoices/${invoice.id}`,
        { notes: "Maksuaikaa jatkettu", dueDate: "2026-02-28" },
        { cookie }
      ),
      routeContext({ id: invoice.id })
    );
    expect(allowed.status).toBe(200);
    expect((await readJson(allowed)).invoice).toMatchObject({
      notes: "Maksuaikaa jatkettu",
      dueDate: "2026-02-28",
    });
  });

  it("deletes a draft but never a sent invoice", async () => {
    const draft = await makeInvoice();
    expect(
      (
        await deleteInvoice(
          buildRequest("DELETE", `/api/invoices/${draft.id}`, undefined, { cookie }),
          routeContext({ id: draft.id })
        )
      ).status
    ).toBe(200);
    expect(await prisma.invoiceLine.count({ where: { invoiceId: draft.id } })).toBe(0);

    const sent = await makeInvoice();
    await send(sent.id);
    expect(
      (
        await deleteInvoice(
          buildRequest("DELETE", `/api/invoices/${sent.id}`, undefined, { cookie }),
          routeContext({ id: sent.id })
        )
      ).status
    ).toBe(409);
  });

  it("404s on another user's invoice", async () => {
    const invoice = await makeInvoice();
    const context = routeContext({ id: invoice.id });
    expect(
      (
        await getInvoice(
          buildRequest("GET", `/api/invoices/${invoice.id}`, undefined, { cookie: otherCookie }),
          context
        )
      ).status
    ).toBe(404);
  });
});

describe("status transitions", () => {
  it("freezes parties when issued and refuses a bare paid flag", async () => {
    await prisma.user.update({
      where: { id: user.id },
      data: { businessName: "Vanha Toiminimi" },
    });
    const invoice = await makeInvoice();
    const sent = await send(invoice.id);
    expect(sent.status).toBe("sent");
    expect(sent.sentAt).not.toBeNull();

    const stored = await prisma.salesInvoice.findUnique({ where: { id: invoice.id } });
    expect(stored?.partySnapshot).toContain("Vanha Toiminimi");
    expect(stored?.partySnapshot).toContain("Anna Asiakas");

    const bare = await setStatus(
      buildRequest("POST", `/api/invoices/${invoice.id}/status`, { status: "paid" }, { cookie }),
      routeContext({ id: invoice.id })
    );
    expect(bare.status).toBe(409);
    expect((await readJson(bare)).error.code).toBe("PAID_REQUIRES_SETTLEMENT");

    const closed = await readJson(
      await setStatus(
        buildRequest(
          "POST",
          `/api/invoices/${invoice.id}/status`,
          { status: "paid", closeReason: "luottotappio" },
          { cookie }
        ),
        routeContext({ id: invoice.id })
      )
    );
    expect(closed.invoice).toMatchObject({
      status: "paid",
      open: 0,
      closedReason: "luottotappio",
    });
    expect(closed.invoice.paidAt).not.toBeNull();
  });

  it("refuses to jump from draft straight to paid", async () => {
    const invoice = await makeInvoice();
    const response = await setStatus(
      buildRequest("POST", `/api/invoices/${invoice.id}/status`, { status: "paid" }, { cookie }),
      routeContext({ id: invoice.id })
    );
    expect(response.status).toBe(409);
    expect((await readJson(response)).error.code).toBe("INVALID_TRANSITION");
  });

  it("makes crediting final", async () => {
    const invoice = await makeInvoice();
    await send(invoice.id);
    const direct = await setStatus(
      buildRequest("POST", `/api/invoices/${invoice.id}/status`, { status: "credited" }, { cookie }),
      routeContext({ id: invoice.id })
    );
    expect(direct.status).toBe(409);
    expect((await readJson(direct)).error.code).toBe("CREDIT_NOTE_REQUIRED");

    const { POST: creditInvoice } = await import("@/app/api/invoices/[id]/credit/route");
    const credited = await creditInvoice(
      buildRequest("POST", `/api/invoices/${invoice.id}/credit`, {}, { cookie }),
      routeContext({ id: invoice.id })
    );
    expect(credited.status).toBe(201);

    const back = await setStatus(
      buildRequest("POST", `/api/invoices/${invoice.id}/status`, { status: "sent" }, { cookie }),
      routeContext({ id: invoice.id })
    );
    expect(back.status).toBe(409);
  });

  it("refuses to return an invoice with payments to draft", async () => {
    const invoice = await makeInvoice();
    await send(invoice.id);
    // Partial, so the invoice stays "sent" and the transition itself is legal;
    // the payment guard is what must stop it.
    await addPayment(
      buildRequest(
        "POST",
        `/api/invoices/${invoice.id}/payments`,
        { amount: 50, paidDate: "2026-01-15" },
        { cookie }
      ),
      routeContext({ id: invoice.id })
    );

    const response = await setStatus(
      buildRequest("POST", `/api/invoices/${invoice.id}/status`, { status: "draft" }, { cookie }),
      routeContext({ id: invoice.id })
    );
    expect(response.status).toBe(409);
    expect((await readJson(response)).error.code).toBe("INVOICE_HAS_PAYMENTS");
  });

  it("keeps a written-off invoice closed when its payment is removed", async () => {
    const invoice = await makeInvoice();
    await send(invoice.id);
    const partial = await readJson(
      await addPayment(
        buildRequest(
          "POST",
          `/api/invoices/${invoice.id}/payments`,
          { amount: 50, paidDate: "2026-01-15" },
          { cookie }
        ),
        routeContext({ id: invoice.id })
      )
    );
    await setStatus(
      buildRequest(
        "POST",
        `/api/invoices/${invoice.id}/status`,
        { status: "paid", closeReason: "luottotappio" },
        { cookie }
      ),
      routeContext({ id: invoice.id })
    );

    const still = await readJson(
      await deletePayment(
        buildRequest(
          "DELETE",
          `/api/invoices/${invoice.id}/payments?paymentId=${partial.invoice.payments[0].id}`,
          undefined,
          { cookie }
        ),
        routeContext({ id: invoice.id })
      )
    );
    expect(still.invoice).toMatchObject({
      status: "paid",
      open: 0,
      paid: 0,
      closedReason: "luottotappio",
    });
  });

  it("refuses paid -> draft outright", async () => {
    const invoice = await makeInvoice();
    await send(invoice.id);
    await addPayment(
      buildRequest(
        "POST",
        `/api/invoices/${invoice.id}/payments`,
        { amount: 125.5, paidDate: "2026-01-15" },
        { cookie }
      ),
      routeContext({ id: invoice.id })
    );

    const response = await setStatus(
      buildRequest("POST", `/api/invoices/${invoice.id}/status`, { status: "draft" }, { cookie }),
      routeContext({ id: invoice.id })
    );
    expect(response.status).toBe(409);
    expect((await readJson(response)).error.code).toBe("INVALID_TRANSITION");
  });
});

describe("payments", () => {
  async function sentInvoice() {
    const invoice = await makeInvoice();
    await send(invoice.id);
    return invoice;
  }

  it("keeps a partly paid invoice open and closes it when covered", async () => {
    const invoice = await sentInvoice();

    const partial = await readJson(
      await addPayment(
        buildRequest(
          "POST",
          `/api/invoices/${invoice.id}/payments`,
          { amount: 100, paidDate: "2026-01-15" },
          { cookie }
        ),
        routeContext({ id: invoice.id })
      )
    );
    expect(partial.invoice).toMatchObject({ status: "sent", paid: 100, open: 25.5 });

    const rest = await readJson(
      await addPayment(
        buildRequest(
          "POST",
          `/api/invoices/${invoice.id}/payments`,
          { amount: 25.5, paidDate: "2026-01-20" },
          { cookie }
        ),
        routeContext({ id: invoice.id })
      )
    );
    expect(rest.invoice).toMatchObject({ status: "paid", paid: 125.5, open: 0 });
    expect(rest.invoice.paidAt).not.toBeNull();
  });

  it("treats an overpayment as settled", async () => {
    const invoice = await sentInvoice();
    const result = await readJson(
      await addPayment(
        buildRequest(
          "POST",
          `/api/invoices/${invoice.id}/payments`,
          { amount: 130, paidDate: "2026-01-15" },
          { cookie }
        ),
        routeContext({ id: invoice.id })
      )
    );
    expect(result.invoice.status).toBe("paid");
    expect(result.invoice.open).toBe(-4.5);
  });

  it("reopens the invoice when the payment is removed", async () => {
    const invoice = await sentInvoice();
    const paid = await readJson(
      await addPayment(
        buildRequest(
          "POST",
          `/api/invoices/${invoice.id}/payments`,
          { amount: 125.5, paidDate: "2026-01-15" },
          { cookie }
        ),
        routeContext({ id: invoice.id })
      )
    );
    expect(paid.invoice.status).toBe("paid");

    const reopened = await readJson(
      await deletePayment(
        buildRequest(
          "DELETE",
          `/api/invoices/${invoice.id}/payments?paymentId=${paid.invoice.payments[0].id}`,
          undefined,
          { cookie }
        ),
        routeContext({ id: invoice.id })
      )
    );
    expect(reopened.invoice).toMatchObject({ status: "sent", paid: 0, open: 125.5 });
    expect(reopened.invoice.paidAt).toBeNull();
  });

  it("refuses a payment on a draft and a zero amount", async () => {
    const draft = await makeInvoice();
    const onDraft = await addPayment(
      buildRequest(
        "POST",
        `/api/invoices/${draft.id}/payments`,
        { amount: 10, paidDate: "2026-01-15" },
        { cookie }
      ),
      routeContext({ id: draft.id })
    );
    expect(onDraft.status).toBe(409);

    const invoice = await sentInvoice();
    const zero = await addPayment(
      buildRequest(
        "POST",
        `/api/invoices/${invoice.id}/payments`,
        { amount: 0, paidDate: "2026-01-15" },
        { cookie }
      ),
      routeContext({ id: invoice.id })
    );
    expect(zero.status).toBe(400);
  });

  it("refuses a bank row that belongs to someone else or is already used", async () => {
    const account = await createBankAccountRow(user.id, { name: "Nordea" });
    const statement = await createStatementWithTransactions(user.id, {
      bankAccountId: account.id,
      transactions: [{ date: "2026-01-15", amountCents: 125_50 }],
    });
    const transactionId = statement.transactions[0].id;

    const foreignStatement = await createStatementWithTransactions(otherUser.id, {
      transactions: [{ date: "2026-01-15", amountCents: 125_50 }],
    });

    const first = await sentInvoice();
    const second = await sentInvoice();

    const foreign = await addPayment(
      buildRequest(
        "POST",
        `/api/invoices/${first.id}/payments`,
        {
          amount: 125.5,
          paidDate: "2026-01-15",
          transactionId: foreignStatement.transactions[0].id,
        },
        { cookie }
      ),
      routeContext({ id: first.id })
    );
    expect(foreign.status).toBe(404);

    const ok = await addPayment(
      buildRequest(
        "POST",
        `/api/invoices/${first.id}/payments`,
        { amount: 125.5, paidDate: "2026-01-15", transactionId },
        { cookie }
      ),
      routeContext({ id: first.id })
    );
    expect(ok.status).toBe(201);

    const reused = await addPayment(
      buildRequest(
        "POST",
        `/api/invoices/${second.id}/payments`,
        { amount: 125.5, paidDate: "2026-01-15", transactionId },
        { cookie }
      ),
      routeContext({ id: second.id })
    );
    expect(reused.status).toBe(409);
    expect((await readJson(reused)).error.code).toBe("TRANSACTION_ALREADY_USED");
  });

  it("keeps the payment when the underlying bank row disappears", async () => {
    const account = await createBankAccountRow(user.id, { name: "Nordea" });
    const statement = await createStatementWithTransactions(user.id, {
      bankAccountId: account.id,
      transactions: [{ date: "2026-01-15", amountCents: 125_50 }],
    });
    const invoice = await sentInvoice();
    await addPayment(
      buildRequest(
        "POST",
        `/api/invoices/${invoice.id}/payments`,
        {
          amount: 125.5,
          paidDate: "2026-01-15",
          transactionId: statement.transactions[0].id,
        },
        { cookie }
      ),
      routeContext({ id: invoice.id })
    );

    await prisma.statement.delete({ where: { id: statement.id } });
    const payments = await prisma.invoicePayment.findMany({ where: { invoiceId: invoice.id } });
    expect(payments).toHaveLength(1);
    expect(payments[0].transactionId).toBeNull();
  });
});

describe("GET /api/invoices", () => {
  it("filters by status and derives overdue from the due date", async () => {
    const draft = await makeInvoice();
    const onTime = await makeInvoice({ issueDate: "2026-01-10", dueDate: "2999-01-01" });
    const late = await makeInvoice({ issueDate: "2026-01-10", dueDate: "2026-01-24" });
    await send(onTime.id);
    await send(late.id);

    const all = await readJson(
      await listInvoices(buildRequest("GET", "/api/invoices", undefined, { cookie }))
    );
    expect(all.invoices).toHaveLength(3);

    const drafts = await readJson(
      await listInvoices(buildRequest("GET", "/api/invoices?status=draft", undefined, { cookie }))
    );
    expect(drafts.invoices.map((i: JsonValue) => i.id)).toEqual([draft.id]);

    const overdue = await readJson(
      await listInvoices(buildRequest("GET", "/api/invoices?status=overdue", undefined, { cookie }))
    );
    expect(overdue.invoices.map((i: JsonValue) => i.id)).toEqual([late.id]);
    expect(overdue.invoices[0].displayStatus).toBe("overdue");
  });

  it("reports receivables aging over sent invoices only", async () => {
    const late = await makeInvoice({ issueDate: "2026-01-10", dueDate: "2026-01-24" });
    await send(late.id);
    await makeInvoice(); // draft, must not count

    const body = await readJson(
      await listInvoices(buildRequest("GET", "/api/invoices", undefined, { cookie }))
    );
    expect(body.aging.totalOpen).toBe(125.5);
    expect(body.aging.overdue).toBe(125.5);
    expect(body.aging.overdueCount).toBe(1);
    expect(body.aging.buckets["90+"].count).toBe(1);
  });

  it("filters by month and by customer", async () => {
    const other = await makeCustomer(cookie, { name: "Toinen asiakas" });
    await makeInvoice({ issueDate: "2026-01-10" });
    await makeInvoice({ issueDate: "2026-02-10", customerId: other.id });

    const january = await readJson(
      await listInvoices(buildRequest("GET", "/api/invoices?month=2026-01", undefined, { cookie }))
    );
    expect(january.invoices).toHaveLength(1);

    const byCustomer = await readJson(
      await listInvoices(
        buildRequest("GET", `/api/invoices?customerId=${other.id}`, undefined, { cookie })
      )
    );
    expect(byCustomer.invoices).toHaveLength(1);
    expect(byCustomer.invoices[0].customer.id).toBe(other.id);
  });

  it("rejects a bogus status filter", async () => {
    const response = await listInvoices(
      buildRequest("GET", "/api/invoices?status=nonsense", undefined, { cookie })
    );
    expect(response.status).toBe(400);
  });
});

describe("POST /api/invoices/match - bank reconciliation", () => {
  async function sentInvoiceWithReference() {
    const invoice = await makeInvoice();
    await send(invoice.id);
    return invoice;
  }

  it("applies a payment when the bank row carries the invoice reference", async () => {
    const invoice = await sentInvoiceWithReference();
    const account = await createBankAccountRow(user.id, { name: "Nordea" });
    const statement = await prisma.statement.create({
      data: {
        userId: user.id,
        bankAccountId: account.id,
        fileName: "tiliote.csv",
        fileType: "csv",
        filePath: "/tmp/x.csv",
        periodMonth: "2026-01",
        transactions: {
          create: [
            {
              date: new Date("2026-01-15T00:00:00Z"),
              amountCents: 125_50,
              counterparty: "Anna Asiakas",
              reference: invoice.reference,
              type: "tulo",
            },
          ],
        },
      },
      include: { transactions: true },
    });

    const result = await readJson(
      await runMatch(buildRequest("POST", "/api/invoices/match", undefined, { cookie }))
    );
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toMatchObject({
      invoiceNumber: invoice.number,
      transactionId: statement.transactions[0].id,
      amount: 125.5,
    });

    const stored = await prisma.salesInvoice.findUnique({ where: { id: invoice.id } });
    expect(stored?.status).toBe("paid");
  });

  it("finds the reference in the message field too, and never applies twice", async () => {
    const invoice = await sentInvoiceWithReference();
    await createStatementWithTransactions(user.id, { transactions: [] });
    await prisma.statement.create({
      data: {
        userId: user.id,
        fileName: "tiliote2.csv",
        fileType: "csv",
        filePath: "/tmp/y.csv",
        periodMonth: "2026-01",
        transactions: {
          create: [
            {
              date: new Date("2026-01-15T00:00:00Z"),
              amountCents: 125_50,
              message: invoice.reference,
              type: "tulo",
            },
          ],
        },
      },
    });

    const first = await readJson(
      await runMatch(buildRequest("POST", "/api/invoices/match", undefined, { cookie }))
    );
    expect(first.applied).toHaveLength(1);

    const second = await readJson(
      await runMatch(buildRequest("POST", "/api/invoices/match", undefined, { cookie }))
    );
    expect(second.applied).toHaveLength(0);
    expect(await prisma.invoicePayment.count()).toBe(1);
  });

  it("only suggests when the amount matches but the reference does not", async () => {
    const invoice = await sentInvoiceWithReference();
    await createStatementWithTransactions(user.id, {
      transactions: [{ date: "2026-01-15", amountCents: 125_50 }],
    });

    const result = await readJson(
      await runMatch(buildRequest("POST", "/api/invoices/match", undefined, { cookie }))
    );
    expect(result.applied).toHaveLength(0);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toMatchObject({
      invoiceNumber: invoice.number,
      amount: 125.5,
      reason: "amount_and_date",
    });
    // A suggestion must not touch the books.
    expect(await prisma.invoicePayment.count()).toBe(0);
    expect((await prisma.salesInvoice.findUnique({ where: { id: invoice.id } }))?.status).toBe("sent");
  });

  it("ignores outgoing money and payments dated before the invoice", async () => {
    await sentInvoiceWithReference();
    await createStatementWithTransactions(user.id, {
      transactions: [
        { date: "2026-01-15", amountCents: -125_50 },
        { date: "2026-01-01", amountCents: 125_50 },
      ],
    });

    const result = await readJson(
      await runMatch(buildRequest("POST", "/api/invoices/match", undefined, { cookie }))
    );
    expect(result.applied).toHaveLength(0);
    expect(result.suggestions).toHaveLength(0);
  });

  it("never pays another user's invoice from this user's bank rows", async () => {
    const foreignCustomer = await makeCustomer(otherCookie, { name: "Toisen asiakas" });
    const foreignInvoice = await readJson(
      await createInvoice(
        buildRequest(
          "POST",
          "/api/invoices",
          { customerId: foreignCustomer.id, issueDate: "2026-01-10", lines: [LINE] },
          { cookie: otherCookie }
        )
      )
    );
    await setStatus(
      buildRequest(
        "POST",
        `/api/invoices/${foreignInvoice.invoice.id}/status`,
        { status: "sent" },
        { cookie: otherCookie }
      ),
      routeContext({ id: foreignInvoice.invoice.id })
    );

    await createStatementWithTransactions(user.id, {
      transactions: [{ date: "2026-01-15", amountCents: 125_50 }],
    });
    await prisma.transaction.updateMany({
      data: { reference: foreignInvoice.invoice.reference },
    });

    const result = await readJson(
      await runMatch(buildRequest("POST", "/api/invoices/match", undefined, { cookie }))
    );
    expect(result.applied).toHaveLength(0);
    expect(await prisma.invoicePayment.count()).toBe(0);
  });
});
