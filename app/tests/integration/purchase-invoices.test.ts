import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import {
  GET as listPurchases,
  POST as createPurchase,
} from "@/app/api/purchase-invoices/route";
import {
  DELETE as deletePurchase,
  GET as getPurchase,
  PATCH as patchPurchase,
} from "@/app/api/purchase-invoices/[id]/route";
import {
  DELETE as deletePurchasePayment,
  POST as addPurchasePayment,
} from "@/app/api/purchase-invoices/[id]/payments/route";
import { POST as runPurchaseMatch } from "@/app/api/purchase-invoices/match/route";
import { createReferenceNumber } from "@/lib/finnish-reference";
import {
  createBankAccountRow,
  createReceipt,
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

const REFERENCE = createReferenceNumber("55512");

const BASE = {
  supplierName: "Tukku Oy",
  issueDate: "2026-01-10",
  dueDate: "2026-01-24",
  gross: 124,
  vat: 24,
};

async function postPurchase(body: Record<string, unknown> = {}, auth = cookie) {
  return createPurchase(
    buildRequest("POST", "/api/purchase-invoices", { ...BASE, ...body }, { cookie: auth })
  );
}

async function makePurchase(body: Record<string, unknown> = {}) {
  const response = await postPurchase(body);
  expect(response.status).toBe(201);
  return (await readJson(response)).invoice;
}

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  otherUser = await createUser();
  otherCookie = await sessionCookie(otherUser);
});

describe("POST /api/purchase-invoices", () => {
  it("stores the payable and derives the net amount", async () => {
    const invoice = await makePurchase();
    expect(invoice).toMatchObject({
      supplierName: "Tukku Oy",
      gross: 124,
      vat: 24,
      net: 100,
      open: 124,
      status: "open",
      displayStatus: "overdue", // due 24.1.2026, so it is late by now
    });
  });

  it("validates the supplier's Y-tunnus, IBAN and viitenumero", async () => {
    expect((await postPurchase({ supplierBusinessId: "0201256-5" })).status).toBe(400);
    expect((await postPurchase({ supplierIban: "FI2112345600000786" })).status).toBe(400);
    expect((await postPurchase({ reference: "1234562" })).status).toBe(400);

    const ok = await makePurchase({
      supplierBusinessId: "02012566",
      supplierIban: "FI21 1234 5600 0007 85",
      reference: REFERENCE,
    });
    expect(ok).toMatchObject({
      supplierBusinessId: "0201256-6",
      supplierIban: "FI2112345600000785",
      reference: REFERENCE,
    });
  });

  it("rejects impossible amounts and dates", async () => {
    expect((await postPurchase({ gross: 0 })).status).toBe(400);
    expect((await postPurchase({ gross: -50 })).status).toBe(400);
    expect((await postPurchase({ gross: 100, vat: 150 })).status).toBe(400);
    expect((await postPurchase({ dueDate: "2026-01-09" })).status).toBe(400);
    expect((await postPurchase({ supplierName: "  " })).status).toBe(400);
    expect(await prisma.purchaseInvoice.count()).toBe(0);
  });

  it("defaults VAT to zero when it is not known", async () => {
    const invoice = await makePurchase({ vat: undefined });
    expect(invoice).toMatchObject({ vat: 0, net: 124 });
  });

  it("links a receipt, and refuses to link the same one twice", async () => {
    const receipt = await createReceipt(user.id, { date: "2026-01-10" });
    const first = await makePurchase({ receiptId: receipt.id });
    expect(first.receiptId).toBe(receipt.id);

    const second = await postPurchase({ receiptId: receipt.id });
    expect(second.status).toBe(409);
    expect((await readJson(second)).error.code).toBe("RECEIPT_IN_USE");
  });

  it("refuses another user's receipt", async () => {
    const receipt = await createReceipt(otherUser.id, { date: "2026-01-10" });
    expect((await postPurchase({ receiptId: receipt.id })).status).toBe(404);
  });

  it("requires a session and blocks cross-site posts", async () => {
    expect(
      (await createPurchase(buildRequest("POST", "/api/purchase-invoices", BASE))).status
    ).toBe(401);
    expect(
      (
        await createPurchase(
          buildRequest("POST", "/api/purchase-invoices", BASE, {
            cookie,
            secFetchSite: "cross-site",
          })
        )
      ).status
    ).toBe(403);
  });
});

describe("GET /api/purchase-invoices", () => {
  it("reports payables aging over open invoices only", async () => {
    await makePurchase({ dueDate: "2026-01-24" }); // long overdue
    const paid = await makePurchase({ dueDate: "2026-01-24" });
    await addPurchasePayment(
      buildRequest(
        "POST",
        `/api/purchase-invoices/${paid.id}/payments`,
        { amount: 124, paidDate: "2026-01-20" },
        { cookie }
      ),
      routeContext({ id: paid.id })
    );

    const body = await readJson(
      await listPurchases(buildRequest("GET", "/api/purchase-invoices", undefined, { cookie }))
    );
    expect(body.aging.totalOpen).toBe(124);
    expect(body.aging.overdue).toBe(124);
    expect(body.aging.overdueCount).toBe(1);
    expect(body.invoices).toHaveLength(2);
  });

  it("filters by status, overdue and month", async () => {
    await makePurchase({ issueDate: "2026-01-10", dueDate: "2026-01-24" });
    await makePurchase({ issueDate: "2026-02-10", dueDate: "2999-01-01" });

    const open = await readJson(
      await listPurchases(
        buildRequest("GET", "/api/purchase-invoices?status=open", undefined, { cookie })
      )
    );
    expect(open.invoices).toHaveLength(2);

    const overdue = await readJson(
      await listPurchases(
        buildRequest("GET", "/api/purchase-invoices?status=overdue", undefined, { cookie })
      )
    );
    expect(overdue.invoices).toHaveLength(1);
    expect(overdue.invoices[0].displayStatus).toBe("overdue");

    const february = await readJson(
      await listPurchases(
        buildRequest("GET", "/api/purchase-invoices?month=2026-02", undefined, { cookie })
      )
    );
    expect(february.invoices).toHaveLength(1);
  });

  it("rejects a bogus status filter and never shows another user's payables", async () => {
    await postPurchase({ supplierName: "Toisen tukku" }, otherCookie);
    expect(
      (
        await listPurchases(
          buildRequest("GET", "/api/purchase-invoices?status=nonsense", undefined, { cookie })
        )
      ).status
    ).toBe(400);

    const body = await readJson(
      await listPurchases(buildRequest("GET", "/api/purchase-invoices", undefined, { cookie }))
    );
    expect(body.invoices).toEqual([]);
  });
});

describe("PATCH / DELETE /api/purchase-invoices/[id]", () => {
  it("updates fields and recomputes the net", async () => {
    const invoice = await makePurchase();
    const body = await readJson(
      await patchPurchase(
        buildRequest(
          "PATCH",
          `/api/purchase-invoices/${invoice.id}`,
          { gross: 200, vat: 40, category: "tarvikkeet" },
          { cookie }
        ),
        routeContext({ id: invoice.id })
      )
    );
    expect(body.invoice).toMatchObject({ gross: 200, vat: 40, net: 160, category: "tarvikkeet" });
  });

  it("refuses to shrink the total below what was already paid", async () => {
    const invoice = await makePurchase();
    await addPurchasePayment(
      buildRequest(
        "POST",
        `/api/purchase-invoices/${invoice.id}/payments`,
        { amount: 100, paidDate: "2026-01-20" },
        { cookie }
      ),
      routeContext({ id: invoice.id })
    );

    const response = await patchPurchase(
      buildRequest("PATCH", `/api/purchase-invoices/${invoice.id}`, { gross: 50 }, { cookie }),
      routeContext({ id: invoice.id })
    );
    expect(response.status).toBe(409);
    expect((await readJson(response)).error.code).toBe("AMOUNT_BELOW_PAYMENTS");
  });

  it("cancels an untouched invoice but not one with payments", async () => {
    const clean = await makePurchase();
    const cancelled = await readJson(
      await patchPurchase(
        buildRequest(
          "PATCH",
          `/api/purchase-invoices/${clean.id}`,
          { status: "cancelled" },
          { cookie }
        ),
        routeContext({ id: clean.id })
      )
    );
    expect(cancelled.invoice.status).toBe("cancelled");

    const paidUp = await makePurchase();
    await addPurchasePayment(
      buildRequest(
        "POST",
        `/api/purchase-invoices/${paidUp.id}/payments`,
        { amount: 124, paidDate: "2026-01-20" },
        { cookie }
      ),
      routeContext({ id: paidUp.id })
    );
    const blocked = await patchPurchase(
      buildRequest(
        "PATCH",
        `/api/purchase-invoices/${paidUp.id}`,
        { status: "cancelled" },
        { cookie }
      ),
      routeContext({ id: paidUp.id })
    );
    expect(blocked.status).toBe(409);
  });

  it("deletes an untouched invoice and refuses one with payments", async () => {
    const clean = await makePurchase();
    expect(
      (
        await deletePurchase(
          buildRequest("DELETE", `/api/purchase-invoices/${clean.id}`, undefined, { cookie }),
          routeContext({ id: clean.id })
        )
      ).status
    ).toBe(200);

    const withPayment = await makePurchase();
    await addPurchasePayment(
      buildRequest(
        "POST",
        `/api/purchase-invoices/${withPayment.id}/payments`,
        { amount: 10, paidDate: "2026-01-20" },
        { cookie }
      ),
      routeContext({ id: withPayment.id })
    );
    expect(
      (
        await deletePurchase(
          buildRequest("DELETE", `/api/purchase-invoices/${withPayment.id}`, undefined, {
            cookie,
          }),
          routeContext({ id: withPayment.id })
        )
      ).status
    ).toBe(409);
  });

  it("404s on another user's payable", async () => {
    const foreign = await readJson(await postPurchase({}, otherCookie));
    const context = routeContext({ id: foreign.invoice.id });
    expect(
      (
        await getPurchase(
          buildRequest("GET", `/api/purchase-invoices/${foreign.invoice.id}`, undefined, {
            cookie,
          }),
          context
        )
      ).status
    ).toBe(404);
    expect(
      (
        await patchPurchase(
          buildRequest(
            "PATCH",
            `/api/purchase-invoices/${foreign.invoice.id}`,
            { gross: 1 },
            { cookie }
          ),
          context
        )
      ).status
    ).toBe(404);
  });
});

describe("purchase payments", () => {
  it("closes the invoice when it is fully paid and reopens it when the payment is removed", async () => {
    const invoice = await makePurchase();

    const partial = await readJson(
      await addPurchasePayment(
        buildRequest(
          "POST",
          `/api/purchase-invoices/${invoice.id}/payments`,
          { amount: 24, paidDate: "2026-01-20" },
          { cookie }
        ),
        routeContext({ id: invoice.id })
      )
    );
    expect(partial.invoice).toMatchObject({ status: "open", paid: 24, open: 100 });

    const full = await readJson(
      await addPurchasePayment(
        buildRequest(
          "POST",
          `/api/purchase-invoices/${invoice.id}/payments`,
          { amount: 100, paidDate: "2026-01-21" },
          { cookie }
        ),
        routeContext({ id: invoice.id })
      )
    );
    expect(full.invoice).toMatchObject({ status: "paid", open: 0 });
    expect(full.invoice.paidAt).not.toBeNull();

    const reopened = await readJson(
      await deletePurchasePayment(
        buildRequest(
          "DELETE",
          `/api/purchase-invoices/${invoice.id}/payments?paymentId=${full.invoice.payments[1].id}`,
          undefined,
          { cookie }
        ),
        routeContext({ id: invoice.id })
      )
    );
    expect(reopened.invoice).toMatchObject({ status: "open", paid: 24 });
    expect(reopened.invoice.paidAt).toBeNull();
  });

  it("refuses a paid status without a payment or a reason", async () => {
    const invoice = await makePurchase();
    const response = await patchPurchase(
      buildRequest(
        "PATCH",
        `/api/purchase-invoices/${invoice.id}`,
        { status: "paid" },
        { cookie }
      ),
      routeContext({ id: invoice.id })
    );
    expect(response.status).toBe(409);
    expect((await readJson(response)).error.code).toBe("PAID_REQUIRES_SETTLEMENT");
    const stored = await prisma.purchaseInvoice.findUnique({ where: { id: invoice.id } });
    expect(stored?.status).toBe("open");
  });

  it("closes a payable with a reason and reports no open balance", async () => {
    const invoice = await makePurchase();
    const closed = await readJson(
      await patchPurchase(
        buildRequest(
          "PATCH",
          `/api/purchase-invoices/${invoice.id}`,
          { status: "paid", closeReason: "maksettu käteisellä" },
          { cookie }
        ),
        routeContext({ id: invoice.id })
      )
    );
    expect(closed.invoice).toMatchObject({
      status: "paid",
      open: 0,
      paid: 0,
      closedReason: "maksettu käteisellä",
    });
  });

  it("refuses a non-positive payment and a cancelled invoice", async () => {
    const invoice = await makePurchase();
    expect(
      (
        await addPurchasePayment(
          buildRequest(
            "POST",
            `/api/purchase-invoices/${invoice.id}/payments`,
            { amount: 0, paidDate: "2026-01-20" },
            { cookie }
          ),
          routeContext({ id: invoice.id })
        )
      ).status
    ).toBe(400);

    await patchPurchase(
      buildRequest(
        "PATCH",
        `/api/purchase-invoices/${invoice.id}`,
        { status: "cancelled" },
        { cookie }
      ),
      routeContext({ id: invoice.id })
    );
    const response = await addPurchasePayment(
      buildRequest(
        "POST",
        `/api/purchase-invoices/${invoice.id}/payments`,
        { amount: 10, paidDate: "2026-01-20" },
        { cookie }
      ),
      routeContext({ id: invoice.id })
    );
    expect(response.status).toBe(409);
  });

  it("never lets one bank row pay two payables", async () => {
    const account = await createBankAccountRow(user.id, { name: "Nordea" });
    const statement = await createStatementWithTransactions(user.id, {
      bankAccountId: account.id,
      transactions: [{ date: "2026-01-20", amountCents: -124_00 }],
    });
    const transactionId = statement.transactions[0].id;

    const first = await makePurchase();
    const second = await makePurchase();

    expect(
      (
        await addPurchasePayment(
          buildRequest(
            "POST",
            `/api/purchase-invoices/${first.id}/payments`,
            { amount: 124, paidDate: "2026-01-20", transactionId },
            { cookie }
          ),
          routeContext({ id: first.id })
        )
      ).status
    ).toBe(201);

    const reused = await addPurchasePayment(
      buildRequest(
        "POST",
        `/api/purchase-invoices/${second.id}/payments`,
        { amount: 124, paidDate: "2026-01-20", transactionId },
        { cookie }
      ),
      routeContext({ id: second.id })
    );
    expect(reused.status).toBe(409);
    expect((await readJson(reused)).error.code).toBe("TRANSACTION_ALREADY_USED");
  });
});

describe("POST /api/purchase-invoices/match", () => {
  async function outgoing(amountCents: number, extra: Record<string, unknown> = {}) {
    const account = await createBankAccountRow(user.id, { name: "Nordea" });
    return prisma.statement.create({
      data: {
        userId: user.id,
        bankAccountId: account.id,
        fileName: "tiliote.csv",
        fileType: "csv",
        filePath: `/tmp/${Math.random()}.csv`,
        periodMonth: "2026-01",
        transactions: {
          create: [
            {
              date: new Date("2026-01-20T00:00:00Z"),
              amountCents,
              counterparty: "Tukku Oy",
              type: "meno",
              ...extra,
            },
          ],
        },
      },
      include: { transactions: true },
    });
  }

  it("pays a payable automatically when the bank row carries its reference", async () => {
    const invoice = await makePurchase({ reference: REFERENCE });
    const statement = await outgoing(-124_00, { reference: REFERENCE });

    const result = await readJson(
      await runPurchaseMatch(
        buildRequest("POST", "/api/purchase-invoices/match", undefined, { cookie })
      )
    );
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toMatchObject({
      invoiceId: invoice.id,
      transactionId: statement.transactions[0].id,
      amount: 124,
    });
    expect(
      (await prisma.purchaseInvoice.findUnique({ where: { id: invoice.id } }))?.status
    ).toBe("paid");
  });

  it("does not apply twice on a second run", async () => {
    await makePurchase({ reference: REFERENCE });
    await outgoing(-124_00, { message: REFERENCE });

    const first = await readJson(
      await runPurchaseMatch(
        buildRequest("POST", "/api/purchase-invoices/match", undefined, { cookie })
      )
    );
    const second = await readJson(
      await runPurchaseMatch(
        buildRequest("POST", "/api/purchase-invoices/match", undefined, { cookie })
      )
    );
    expect(first.applied).toHaveLength(1);
    expect(second.applied).toHaveLength(0);
    expect(await prisma.purchasePayment.count()).toBe(1);
  });

  it("only suggests when the amount matches but the reference does not", async () => {
    await makePurchase();
    await outgoing(-124_00);

    const result = await readJson(
      await runPurchaseMatch(
        buildRequest("POST", "/api/purchase-invoices/match", undefined, { cookie })
      )
    );
    expect(result.applied).toHaveLength(0);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]).toMatchObject({ amount: 124, reason: "amount_and_date" });
    expect(await prisma.purchasePayment.count()).toBe(0);
  });

  it("ignores incoming money", async () => {
    await makePurchase({ reference: REFERENCE });
    await outgoing(124_00, { reference: REFERENCE });

    const result = await readJson(
      await runPurchaseMatch(
        buildRequest("POST", "/api/purchase-invoices/match", undefined, { cookie })
      )
    );
    expect(result.applied).toHaveLength(0);
    expect(result.suggestions).toHaveLength(0);
  });

  it("does not touch another user's payables", async () => {
    const foreign = await readJson(
      await postPurchase({ reference: REFERENCE }, otherCookie)
    );
    await outgoing(-124_00, { reference: REFERENCE });

    const result = await readJson(
      await runPurchaseMatch(
        buildRequest("POST", "/api/purchase-invoices/match", undefined, { cookie })
      )
    );
    expect(result.applied).toHaveLength(0);
    expect(
      (await prisma.purchaseInvoice.findUnique({ where: { id: foreign.invoice.id } }))?.status
    ).toBe("open");
  });
});

describe("a recorded payable's VAT reaches the VAT return (F39)", () => {
  it("adds the invoice's VAT to the deductible VAT, by invoice date", async () => {
    const { GET: alvReport } = await import("@/app/api/alv/route");
    const before = await readJson(
      await alvReport(buildRequest("GET", "/api/alv?period=2026-01", undefined, { cookie }))
    );

    await makePurchase({ gross: 1_240, vat: 240 });

    const after = await readJson(
      await alvReport(buildRequest("GET", "/api/alv?period=2026-01", undefined, { cookie }))
    );
    expect(after.field307.amount).toBe(before.field307.amount + 240);
    expect(after.sources.purchaseInvoiceCount).toBe(1);
  });

  it("counts the linked receipt exactly once, through the receipt", async () => {
    const { GET: alvReport } = await import("@/app/api/alv/route");
    const receipt = await createReceipt(user.id, {
      type: "meno",
      date: "2026-01-10",
      totalAmountCents: 124_00,
      vatDetails: JSON.stringify([{ rate: 25.5, amount: 24 }]),
    });
    await makePurchase({ receiptId: receipt.id });

    const body = await readJson(
      await alvReport(buildRequest("GET", "/api/alv?period=2026-01", undefined, { cookie }))
    );
    expect(body.field307.amount).toBe(24);
  });
});

describe("payables reach the dashboard and the CSV export", () => {
  it("shows open payables on the dashboard", async () => {
    const { GET: dashboard } = await import("@/app/api/dashboard/route");
    await makePurchase({ gross: 124, dueDate: "2026-01-24" });

    const body = await readJson(
      await dashboard(buildRequest("GET", "/api/dashboard", undefined, { cookie }))
    );
    expect(body.payables).toMatchObject({ totalOpen: 124, overdue: 124, overdueCount: 1 });
  });

  it("exports payables as CSV with the open amount", async () => {
    const { GET: exportCsv } = await import("@/app/api/export/route");
    await makePurchase({ supplierName: "Tukku; Oy" });

    const response = await exportCsv(
      buildRequest("GET", "/api/export?type=purchase-invoices", undefined, { cookie })
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('"Tukku; Oy"'); // quoted, so the columns hold
    expect(text).toContain("124,00");
    expect(text).toContain("open");
  });
});
