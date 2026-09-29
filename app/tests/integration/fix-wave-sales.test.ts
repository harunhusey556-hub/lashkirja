/**
 * Batch 1 fix wave, lane F2 (sales and accounting), review-3-sales.md:
 * - Important 1: an invoice from a locked month can be credited.
 * - Important 2: the VAT threshold turnover is per month and without VAT.
 * - Important 3: a hand-recorded payment plus an income receipt from the same
 *   bank row is flagged, can be linked or separated, and is offered a bank row
 *   when recorded.
 * - Important 4: a credit note never changes status and is never deleted.
 * - Minors: the match preview respects period locks; PATCH needs a version.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { GET as alvReport } from "@/app/api/alv/route";
import { GET as dashboard } from "@/app/api/dashboard/route";
import { GET as workQueue } from "@/app/api/work-queue/route";
import { POST as createCustomer } from "@/app/api/customers/route";
import { POST as createInvoice } from "@/app/api/invoices/route";
import {
  DELETE as deleteInvoice,
  GET as getInvoice,
  PATCH as patchInvoice,
} from "@/app/api/invoices/[id]/route";
import { POST as setStatus } from "@/app/api/invoices/[id]/status/route";
import { POST as credit } from "@/app/api/invoices/[id]/credit/route";
import { POST as addPayment } from "@/app/api/invoices/[id]/payments/route";
import { GET as paymentCandidates } from "@/app/api/invoices/[id]/payments/candidates/route";
import { POST as linkPayment } from "@/app/api/invoices/[id]/payments/link/route";
import { GET as previewMatch } from "@/app/api/invoices/match/route";
import { createStatementWithTransactions, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";
import { helsinkiMonthKey } from "@/lib/validation";

let user: TestUser;
let cookie: string;
let customerId: string;

const VAT_255 = JSON.stringify([{ rate: 25.5, amount: 25.5 }]);

async function makeInvoice(issueDate = "2026-01-15", unitPrice = 100, vatRate = 25.5) {
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
  return (await readJson(response)).invoice as {
    id: string;
    number: number;
    reference: string;
    updatedAt: string;
  };
}

async function send(id: string) {
  const response = await setStatus(
    buildRequest("POST", `/api/invoices/${id}/status`, { status: "sent" }, { cookie }),
    routeContext({ id })
  );
  expect(response.status).toBe(200);
}

async function lockThrough(month: string | null) {
  await prisma.user.update({ where: { id: user.id }, data: { booksLockedThrough: month } });
}

async function issueCredit(id: string) {
  return credit(
    buildRequest("POST", `/api/invoices/${id}/credit`, undefined, { cookie }),
    routeContext({ id })
  );
}

async function alv(period: string) {
  const response = await alvReport(buildRequest("GET", `/api/alv?period=${period}`, undefined, { cookie }));
  expect(response.status).toBe(200);
  return readJson(response);
}

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  const response = await createCustomer(
    buildRequest("POST", "/api/customers", { name: "Anna Asiakas" }, { cookie })
  );
  customerId = (await readJson(response)).customer.id;
});

describe("Important 1: crediting an invoice from a locked month", () => {
  it("credits a January invoice while the books are locked through June", async () => {
    const invoice = await makeInvoice("2026-01-15");
    await send(invoice.id);
    await lockThrough("2026-06");

    const response = await issueCredit(invoice.id);
    expect(response.status).toBe(201);
    const note = (await readJson(response)).invoice;
    expect(note.documentKind).toBe("credit_note");

    const original = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(original.status).toBe("credited");
    // January (filed) is untouched; the credit lands in the note's own month.
    const january = await alv("2026-01");
    expect(january.field301.netSales).toBe(100);
  });

  it("still refuses when the credit note's own month is locked", async () => {
    const invoice = await makeInvoice("2026-01-15");
    await send(invoice.id);
    await lockThrough(helsinkiMonthKey(new Date()));

    const response = await issueCredit(invoice.id);
    expect(response.status).toBe(409);
    expect((await readJson(response)).error.code).toBe("PERIOD_LOCKED");
  });
});

describe("Important 4: a credit note is immutable", () => {
  async function creditNote() {
    const invoice = await makeInvoice("2026-01-15");
    await send(invoice.id);
    const response = await issueCredit(invoice.id);
    expect(response.status).toBe(201);
    return { invoice, note: (await readJson(response)).invoice as { id: string } };
  }

  it.each(["draft", "paid", "sent", "credited"])("refuses status %s", async (status) => {
    const { note } = await creditNote();
    const response = await setStatus(
      buildRequest(
        "POST",
        `/api/invoices/${note.id}/status`,
        { status, closeReason: "Käteismaksu kassaan" },
        { cookie }
      ),
      routeContext({ id: note.id })
    );
    expect(response.status).toBe(409);
    expect((await readJson(response)).error.code).toBe("CREDIT_NOTE_IMMUTABLE");
    const stored = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: note.id } });
    expect(stored.status).toBe("sent");
  });

  it("refuses the delete, even for a credit note that was forced to draft", async () => {
    const { invoice, note } = await creditNote();
    const first = await deleteInvoice(
      buildRequest("DELETE", `/api/invoices/${note.id}`, undefined, { cookie }),
      routeContext({ id: note.id })
    );
    expect(first.status).toBe(409);
    expect((await readJson(first)).error.code).toBe("CREDIT_NOTE_IMMUTABLE");

    // A row left in draft by the old bug must not be deletable either.
    await prisma.salesInvoice.update({ where: { id: note.id }, data: { status: "draft" } });
    const second = await deleteInvoice(
      buildRequest("DELETE", `/api/invoices/${note.id}`, undefined, { cookie }),
      routeContext({ id: note.id })
    );
    expect(second.status).toBe(409);
    expect(await prisma.salesInvoice.count({ where: { id: note.id } })).toBe(1);
    const original = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
    expect(original.status).toBe("credited");
  });
});

describe("Minor: PATCH needs expectedUpdatedAt", () => {
  it("answers 428 without a version and saves with one", async () => {
    const invoice = await makeInvoice();
    const without = await patchInvoice(
      buildRequest("PATCH", `/api/invoices/${invoice.id}`, { notes: "uusi" }, { cookie }),
      routeContext({ id: invoice.id })
    );
    expect(without.status).toBe(428);
    expect((await readJson(without)).error.code).toBe("PRECONDITION_REQUIRED");
    expect((await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).notes).toBeNull();

    const withVersion = await patchInvoice(
      buildRequest(
        "PATCH",
        `/api/invoices/${invoice.id}`,
        { notes: "uusi", expectedUpdatedAt: invoice.updatedAt },
        { cookie }
      ),
      routeContext({ id: invoice.id })
    );
    expect(withVersion.status).toBe(200);
  });
});

describe("Minor: the match preview respects period locks", () => {
  it("lists a reference hit in a locked month as skipped, not as a booking", async () => {
    const invoice = await makeInvoice("2026-01-10");
    await send(invoice.id);
    await createStatementWithTransactions(user.id, {
      periodMonth: "2026-01",
      transactions: [
        { date: "2026-01-20", amountCents: 125_50 },
        { date: "2026-01-21", amountCents: 999_00 },
      ],
    });
    await prisma.transaction.updateMany({
      where: { amountCents: 125_50 },
      data: { reference: invoice.reference },
    });
    await lockThrough("2026-01");

    const preview = await readJson(
      await previewMatch(buildRequest("GET", "/api/invoices/match", undefined, { cookie }))
    );
    expect(preview.preview).toEqual([]);
    expect(preview.skippedLocked).toHaveLength(1);
    expect(preview.skippedLocked[0].invoiceNumber).toBe(invoice.number);
    expect(preview.suggestions).toEqual([]);
    expect(await prisma.invoicePayment.count()).toBe(0);
  });

  it("names the customer and the payment date in an amount suggestion", async () => {
    const invoice = await makeInvoice("2026-02-01");
    await send(invoice.id);
    await createStatementWithTransactions(user.id, {
      periodMonth: "2026-02",
      transactions: [{ date: "2026-02-10", amountCents: 125_50 }],
    });
    const preview = await readJson(
      await previewMatch(buildRequest("GET", "/api/invoices/match", undefined, { cookie }))
    );
    expect(preview.suggestions).toEqual([
      expect.objectContaining({
        invoiceId: invoice.id,
        customerName: "Anna Asiakas",
        paidDate: "2026-02-10",
        amount: 125.5,
      }),
    ]);
  });
});

describe("Important 3: a hand-recorded payment and an income receipt from the same bank row", () => {
  /** The review's reproduction: paid by hand, receipt drafted from the row. */
  async function reproduce() {
    const invoice = await makeInvoice("2026-01-15");
    await send(invoice.id);
    const statement = await createStatementWithTransactions(user.id, {
      periodMonth: "2026-01",
      transactions: [{ date: "2026-01-20", amountCents: 125_50, counterparty: "Anna Asiakas" }],
    });
    const transactionId = statement.transactions[0].id;
    const paid = await addPayment(
      buildRequest(
        "POST",
        `/api/invoices/${invoice.id}/payments`,
        { amount: 125.5, paidDate: "2026-01-20" },
        { cookie }
      ),
      routeContext({ id: invoice.id })
    );
    expect(paid.status).toBe(201);
    const paymentId = (await readJson(paid)).invoice.payments[0].id as string;
    const receipt = await prisma.receipt.create({
      data: {
        userId: user.id,
        type: "tulo",
        vendor: "Anna Asiakas",
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
    return { invoice, transactionId, paymentId, receiptId: receipt.id };
  }

  async function queueKinds() {
    const body = await readJson(await workQueue(buildRequest("GET", "/api/work-queue", undefined, { cookie })));
    return (body.items as Array<{ kind: string; href: string | null }>).filter(
      (item) => item.kind === "payment_duplicate"
    );
  }

  it("flags the exact reproduction instead of counting it silently", async () => {
    const { invoice, paymentId, receiptId, transactionId } = await reproduce();

    const before = await alv("2026-01");
    // Both still count until the user decides; the report says so.
    expect(before.field301.netSales).toBe(200);
    expect(before.field301.vat).toBe(51);
    expect(before.suspectedDuplicateCount).toBe(1);

    const flagged = await queueKinds();
    expect(flagged).toHaveLength(1);
    expect(flagged[0].href).toContain(invoice.id);

    const detail = await readJson(
      await getInvoice(
        buildRequest("GET", `/api/invoices/${invoice.id}`, undefined, { cookie }),
        routeContext({ id: invoice.id })
      )
    );
    expect(detail.paymentDuplicates).toEqual([
      expect.objectContaining({ paymentId, receiptId, transactionId, invoiceNumber: invoice.number }),
    ]);
  });

  it("linking the payment to the bank row counts the income once", async () => {
    const { invoice, paymentId, transactionId } = await reproduce();
    const response = await linkPayment(
      buildRequest(
        "POST",
        `/api/invoices/${invoice.id}/payments/link`,
        { action: "link", paymentId, transactionId },
        { cookie }
      ),
      routeContext({ id: invoice.id })
    );
    expect(response.status).toBe(200);

    const after = await alv("2026-01");
    expect(after.field301.netSales).toBe(100);
    expect(after.field301.vat).toBe(25.5);
    expect(after.excludedReceiptCount).toBe(1);
    expect(after.suspectedDuplicateCount).toBe(0);
    expect(await queueKinds()).toHaveLength(0);
  });

  it("refuses a link whose amount differs, and a second link of the same row", async () => {
    const { invoice, paymentId, transactionId } = await reproduce();
    const other = await createStatementWithTransactions(user.id, {
      periodMonth: "2026-01",
      transactions: [{ date: "2026-01-20", amountCents: 99_00 }],
    });
    const wrong = await linkPayment(
      buildRequest(
        "POST",
        `/api/invoices/${invoice.id}/payments/link`,
        { action: "link", paymentId, transactionId: other.transactions[0].id },
        { cookie }
      ),
      routeContext({ id: invoice.id })
    );
    expect(wrong.status).toBe(400);

    const ok = await linkPayment(
      buildRequest(
        "POST",
        `/api/invoices/${invoice.id}/payments/link`,
        { action: "link", paymentId, transactionId },
        { cookie }
      ),
      routeContext({ id: invoice.id })
    );
    expect(ok.status).toBe(200);
    const again = await linkPayment(
      buildRequest(
        "POST",
        `/api/invoices/${invoice.id}/payments/link`,
        { action: "link", paymentId, transactionId },
        { cookie }
      ),
      routeContext({ id: invoice.id })
    );
    expect(again.status).toBe(409);
  });

  it("dismissing keeps both incomes and stops the flag", async () => {
    const { invoice, paymentId, receiptId } = await reproduce();
    const response = await linkPayment(
      buildRequest(
        "POST",
        `/api/invoices/${invoice.id}/payments/link`,
        { action: "dismiss", paymentId, receiptId },
        { cookie }
      ),
      routeContext({ id: invoice.id })
    );
    expect(response.status).toBe(200);
    const after = await alv("2026-01");
    expect(after.field301.netSales).toBe(200);
    expect(after.suspectedDuplicateCount).toBe(0);
    expect(await queueKinds()).toHaveLength(0);
  });

  it("offers the unmatched bank row when the payment is recorded, and the linked payment never duplicates", async () => {
    const invoice = await makeInvoice("2026-01-15");
    await send(invoice.id);
    const statement = await createStatementWithTransactions(user.id, {
      periodMonth: "2026-01",
      transactions: [
        { date: "2026-01-22", amountCents: 125_50, counterparty: "Anna Asiakas" },
        { date: "2026-01-02", amountCents: 125_50, counterparty: "Liian kaukana" },
        { date: "2026-01-21", amountCents: 50_00 },
      ],
    });
    const near = statement.transactions.find((row) => row.counterparty === "Anna Asiakas")!;

    const offered = await readJson(
      await paymentCandidates(
        buildRequest(
          "GET",
          `/api/invoices/${invoice.id}/payments/candidates?amount=125.5&paidDate=2026-01-21`,
          undefined,
          { cookie }
        ),
        routeContext({ id: invoice.id })
      )
    );
    expect(offered.candidates).toEqual([
      expect.objectContaining({ transactionId: near.id, date: "2026-01-22", counterparty: "Anna Asiakas" }),
    ]);

    const paid = await addPayment(
      buildRequest(
        "POST",
        `/api/invoices/${invoice.id}/payments`,
        { amount: 125.5, paidDate: "2026-01-21", transactionId: near.id },
        { cookie }
      ),
      routeContext({ id: invoice.id })
    );
    expect(paid.status).toBe(201);
    await prisma.receipt.create({
      data: {
        userId: user.id,
        type: "tulo",
        date: new Date("2026-01-22T00:00:00Z"),
        totalAmountCents: 125_50,
        vatDetails: VAT_255,
        sourceTransactionId: near.id,
        reviewStatus: "approved",
        source: "auto_income",
        filePath: "/tmp/auto.pdf",
        fileName: "auto.pdf",
      },
    });
    const report = await alv("2026-01");
    expect(report.field301.netSales).toBe(100);
    expect(report.suspectedDuplicateCount).toBe(0);
  });

  it("does not offer another user's bank row or a foreign invoice", async () => {
    const invoice = await makeInvoice("2026-01-15");
    const stranger = await createUser();
    await createStatementWithTransactions(stranger.id, {
      periodMonth: "2026-01",
      transactions: [{ date: "2026-01-20", amountCents: 125_50 }],
    });
    const offered = await readJson(
      await paymentCandidates(
        buildRequest(
          "GET",
          `/api/invoices/${invoice.id}/payments/candidates?amount=125.5&paidDate=2026-01-20`,
          undefined,
          { cookie }
        ),
        routeContext({ id: invoice.id })
      )
    );
    expect(offered.candidates).toEqual([]);

    const strangerCookie = await sessionCookie(stranger);
    const foreign = await paymentCandidates(
      buildRequest(
        "GET",
        `/api/invoices/${invoice.id}/payments/candidates?amount=125.5&paidDate=2026-01-20`,
        undefined,
        { cookie: strangerCookie }
      ),
      routeContext({ id: invoice.id })
    );
    expect(foreign.status).toBe(404);
  });
});

describe("Important 2: VAT threshold turnover", () => {
  async function ytd(month: string) {
    const response = await dashboard(buildRequest("GET", `/api/dashboard?month=${month}`, undefined, { cookie }));
    expect(response.status).toBe(200);
    return (await readJson(response)).vat.ytdRevenue as number;
  }

  it("counts documents for months without a statement next to a month that has one", async () => {
    await createStatementWithTransactions(user.id, {
      periodMonth: "2026-01",
      transactions: [{ date: "2026-01-10", amountCents: 1000_00 }],
    });
    const invoice = await makeInvoice("2026-05-05", 20_000, 0);
    await send(invoice.id);
    // Review reproduction: 1 000 € statement + 20 000 € invoice was 1 000.
    expect(await ytd("2026-05")).toBe(21_000);
  });

  it("counts turnover without VAT, and a statement month is never counted twice", async () => {
    const invoice = await makeInvoice("2026-03-05", 1000, 25.5);
    await send(invoice.id);
    // March has a statement: its bank row (the paid invoice) replaces the documents.
    const statement = await createStatementWithTransactions(user.id, {
      periodMonth: "2026-03",
      transactions: [{ date: "2026-03-20", amountCents: 1255_00 }],
    });
    await addPayment(
      buildRequest(
        "POST",
        `/api/invoices/${invoice.id}/payments`,
        { amount: 1255, paidDate: "2026-03-20", transactionId: statement.transactions[0].id },
        { cookie }
      ),
      routeContext({ id: invoice.id })
    );
    const april = await makeInvoice("2026-04-05", 2000, 25.5);
    await send(april.id);
    // 1 000 net from the March row (the invoice's VAT share removed) + 2 000 net in April.
    expect(await ytd("2026-04")).toBe(3000);
  });
});

describe("Important 5: Koti items", () => {
  async function koti(month: string) {
    const response = await dashboard(buildRequest("GET", `/api/dashboard?month=${month}`, undefined, { cookie }));
    expect(response.status).toBe(200);
    return readJson(response);
  }

  async function seed() {
    const overdue = await makeInvoice("2026-01-05", 100);
    await send(overdue.id);
    const matchable = await makeInvoice("2026-02-01", 65);
    await send(matchable.id);
    await createStatementWithTransactions(user.id, {
      periodMonth: "2026-02",
      transactions: [
        { date: "2026-02-10", amountCents: 81_58, counterparty: "Anna Asiakas" },
        { date: "2026-02-12", amountCents: -23_40, counterparty: "K-Market Kallio" },
      ],
    });
    await prisma.receipt.create({
      data: {
        userId: user.id,
        vendor: "Ripsitukku Oy",
        type: "meno",
        date: new Date("2026-02-14T00:00:00Z"),
        totalAmountCents: 139_00,
        category: "Tarvikkeet",
        vatDetails: JSON.stringify([{ rate: 25.5, amount: 28.25 }]),
        reviewStatus: "pending",
        filePath: "/tmp/r.pdf",
        fileName: "r.pdf",
      },
    });
    return { overdue, matchable };
  }

  it("returns one item per thing to do, naming the other party, with the action data", async () => {
    const { overdue, matchable } = await seed();
    const body = await koti(helsinkiMonthKey(new Date()));
    const byKind = (kind: string) => body.items.filter((item: { kind: string }) => item.kind === kind);

    expect(byKind("overdue_invoice")).toEqual([
      expect.objectContaining({
        action: "remind",
        invoiceId: overdue.id,
        number: overdue.number,
        party: "Anna Asiakas",
        amount: 125.5,
      }),
    ]);
    expect(byKind("pending_receipt")).toEqual([
      expect.objectContaining({ action: "approve", party: "Ripsitukku Oy", amount: 139, vatRate: 25.5 }),
    ]);
    expect(byKind("invoice_match")).toEqual([
      expect.objectContaining({
        action: "confirm_match",
        invoiceId: matchable.id,
        number: matchable.number,
        party: "Anna Asiakas",
        amount: 81.58,
        paidDate: "2026-02-10",
      }),
    ]);
    expect(body.itemTotals).toMatchObject({ overdue_invoice: 1, pending_receipt: 1, invoice_match: 1 });
  });

  it("a past month lists only the items tied to it", async () => {
    await seed();
    const january = await koti("2026-01");
    expect(january.items.map((item: { kind: string }) => item.kind)).toEqual(["overdue_invoice"]);

    const february = await koti("2026-02");
    const kinds = february.items.map((item: { kind: string; party: string }) => `${item.kind}:${item.party}`);
    expect(kinds).toEqual([
      "pending_receipt:Ripsitukku Oy",
      "missing_receipt:K-Market Kallio",
      "invoice_match:Anna Asiakas",
    ]);

    const march = await koti("2026-03");
    expect(march.items).toEqual([]);
  });
});
