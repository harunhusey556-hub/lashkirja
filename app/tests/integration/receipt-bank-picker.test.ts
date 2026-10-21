import { beforeEach, describe, expect, it } from "vitest";
import { GET as bankCandidates } from "@/app/api/receipts/[id]/bank-candidates/route";
import { GET as receiptDetail } from "@/app/api/receipts/[id]/route";
import { POST as confirm } from "@/app/api/matching/confirm/route";
import { POST as createPurchase } from "@/app/api/purchase-invoices/route";
import { POST as addPurchasePayment } from "@/app/api/purchase-invoices/[id]/payments/route";
import { prisma } from "@/lib/db";
import { createReceipt, createStatementWithTransactions, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie, type JsonValue } from "./helpers/http";

/**
 * Owner 2026-10-15: a receipt could only be linked to one of the matcher's few suggestions.
 * "Valitse muu pankkitapahtuma" lists every free row of the receipt's direction, paged.
 */

let user: TestUser;
let cookie: string;
let other: TestUser;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  other = await createUser();
});

async function rowsFor(receiptId: string, query = "", auth = cookie) {
  const response = await bankCandidates(
    buildRequest("GET", `/api/receipts/${receiptId}/bank-candidates${query}`, undefined, { cookie: auth }),
    routeContext({ id: receiptId })
  );
  return { status: response.status, body: await readJson(response) };
}

const link = (transactionId: string, receiptId: string, auth = cookie) =>
  confirm(buildRequest("POST", "/api/matching/confirm", { transactionId, receiptId }, { cookie: auth }));

const ids = (body: JsonValue) => body.candidates.map((c: JsonValue) => c.transactionId);

describe("GET /api/receipts/[id]/bank-candidates", () => {
  it("lists every free outgoing row, the best fit first, and pages through all of them", async () => {
    const receipt = await createReceipt(user.id, { totalAmountCents: 25_00, date: "2026-09-03", vendor: "Tukku Oy" });
    const statement = await createStatementWithTransactions(user.id, {
      periodMonth: "2026-09",
      transactions: [
        { date: "2026-09-04", amountCents: -25_00, counterparty: "Tukku Oy" },
        { date: "2026-09-10", amountCents: 50_00, counterparty: "Asiakas" },
        ...Array.from({ length: 34 }, (_, index) => ({
          date: "2026-08-01",
          amountCents: -(1_00 + index),
          counterparty: `Kauppa ${index}`,
        })),
      ],
    });
    const best = statement.transactions.find((row) => row.amountCents === -25_00)!;
    const incoming = statement.transactions.find((row) => row.amountCents === 50_00)!;

    const first = await rowsFor(receipt.id);
    expect(first.status).toBe(200);
    expect(ids(first.body)[0]).toBe(best.id);
    expect(first.body.candidates[0].reasons).toEqual(expect.arrayContaining(["summa sama"]));
    expect(first.body).toMatchObject({ total: 35, offset: 0, hasMore: true });
    expect(first.body.candidates).toHaveLength(30);
    const rest = await rowsFor(receipt.id, "?offset=30");
    expect(rest.body.candidates).toHaveLength(5);
    expect(rest.body.hasMore).toBe(false);
    const all = [...ids(first.body), ...ids(rest.body)];
    expect(new Set(all).size).toBe(35);
    expect(all).not.toContain(incoming.id);

    // A search reaches a row however far down it ranks.
    const hit = await rowsFor(receipt.id, "?q=kauppa%2033");
    expect(hit.body.candidates.map((c: JsonValue) => c.counterparty)).toEqual(["Kauppa 33"]);
  });

  it("leaves out rows that another receipt or a sales payment holds, and offers the receipt's own row", async () => {
    const receipt = await createReceipt(user.id, { totalAmountCents: 25_00, date: "2026-09-03" });
    const another = await createReceipt(user.id, { totalAmountCents: 30_00, date: "2026-09-03", vendor: "Muu Oy" });
    const statement = await createStatementWithTransactions(user.id, {
      periodMonth: "2026-09",
      transactions: [
        { date: "2026-09-04", amountCents: -25_00, counterparty: "Tukku Oy" },
        { date: "2026-09-04", amountCents: -30_00, counterparty: "Muu Oy" },
      ],
    });
    const [own, taken] = [
      statement.transactions.find((row) => row.amountCents === -25_00)!,
      statement.transactions.find((row) => row.amountCents === -30_00)!,
    ];
    expect((await link(taken.id, another.id)).status).toBe(200);
    expect((await link(own.id, receipt.id)).status).toBe(200);
    expect(ids((await rowsFor(receipt.id)).body)).toEqual([own.id]);
  });

  it("404s on another owner's receipt and refuses a page past the cap", async () => {
    const foreign = await createReceipt(other.id);
    expect((await rowsFor(foreign.id)).status).toBe(404);
    const receipt = await createReceipt(user.id);
    expect((await rowsFor(receipt.id, "?limit=500")).status).toBe(400);
  });
});

describe("the receipt and its bank row picker list the same rows alike (X039)", () => {
  it("puts two equally good rows in one order, with the same Finnish reasons", async () => {
    const receipt = await createReceipt(user.id, { totalAmountCents: 25_00, date: "2026-09-03", vendor: "Prisma" });
    await createStatementWithTransactions(user.id, {
      periodMonth: "2026-09",
      transactions: [
        { date: "2026-09-03", amountCents: -18_00, counterparty: "Prisma 18" },
        { date: "2026-09-03", amountCents: -10_00, counterparty: "Prisma 10" },
      ],
    });

    const detail = await receiptDetail(
      buildRequest("GET", `/api/receipts/${receipt.id}`, undefined, { cookie }),
      routeContext({ id: receipt.id })
    );
    expect(detail.status).toBe(200);
    const candidates = (await readJson(detail)).receipt.match.matchCandidates;
    const picker = (await rowsFor(receipt.id)).body.candidates;

    expect(candidates).toHaveLength(2);
    expect(candidates[0].score).toBe(candidates[1].score);
    expect(candidates.map((c: JsonValue) => c.id)).toEqual(ids({ candidates: picker }));
    // The receipt's own words for each row are the picker's ("nimi vastaa · sama päivä"), not codes.
    expect(candidates.map((c: JsonValue) => c.explanation)).toEqual(picker.map((c: JsonValue) => c.reasons));
    expect(candidates[0].explanation.length).toBeGreaterThan(0);
  });

  // The rows above are only related, never gate-eligible; these two the gate itself calls a tie.
  it("gives two rows the gate ties the same order and the same words on both lists", async () => {
    const receipt = await createReceipt(user.id, { totalAmountCents: 25_00, date: "2026-09-03", vendor: "Prisma" });
    await createStatementWithTransactions(user.id, {
      periodMonth: "2026-09",
      transactions: [
        { date: "2026-09-03", amountCents: -25_00, counterparty: "Prisma" },
        { date: "2026-09-03", amountCents: -25_00, counterparty: "Prisma" },
      ],
    });

    const detail = await receiptDetail(
      buildRequest("GET", `/api/receipts/${receipt.id}`, undefined, { cookie }),
      routeContext({ id: receipt.id })
    );
    expect(detail.status).toBe(200);
    const candidates = (await readJson(detail)).receipt.match.matchCandidates;
    const picker = (await rowsFor(receipt.id)).body.candidates;

    expect(candidates).toHaveLength(2);
    expect(candidates[0].score).toBe(candidates[1].score);
    // Both eligible rivals of each other: the gate's tie, not two related rows.
    expect(candidates.every((c: JsonValue) => c.reasons.includes("competing"))).toBe(true);
    expect(candidates.map((c: JsonValue) => c.id)).toEqual(ids({ candidates: picker }));
    expect(candidates.map((c: JsonValue) => c.explanation)).toEqual(picker.map((c: JsonValue) => c.reasons));
    expect(candidates[0].explanation).toContain("summa sama");
  });
});

describe("POST /api/matching/confirm with a hand-picked row", () => {
  it("links the picked row, and refuses another owner's row", async () => {
    const receipt = await createReceipt(user.id, { totalAmountCents: 25_00, date: "2026-09-03" });
    const mine = await createStatementWithTransactions(user.id, {
      periodMonth: "2026-07",
      transactions: [{ date: "2026-07-20", amountCents: -99_00, counterparty: "Jotain Muuta" }],
    });
    const theirs = await createStatementWithTransactions(other.id, {
      periodMonth: "2026-09",
      transactions: [{ date: "2026-09-04", amountCents: -25_00, counterparty: "Tukku Oy" }],
    });
    expect((await link(theirs.transactions[0].id, receipt.id)).status).toBe(404);
    expect((await link(mine.transactions[0].id, receipt.id)).status).toBe(200);
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: mine.transactions[0].id } });
    expect(row).toMatchObject({ receiptId: receipt.id, matchStatus: "confirmed" });
  });

  it("refuses a row that already paid another purchase invoice", async () => {
    const receipt = await createReceipt(user.id, { totalAmountCents: 124_00, date: "2026-01-12" });
    const created = await createPurchase(
      buildRequest(
        "POST",
        "/api/purchase-invoices",
        { supplierName: "Tukku Oy", issueDate: "2026-01-10", dueDate: "2026-01-24", gross: 124, vat: 24 },
        { cookie }
      )
    );
    const invoice = (await readJson(created)).invoice;
    const statement = await createStatementWithTransactions(user.id, {
      periodMonth: "2026-01",
      transactions: [{ date: "2026-01-25", amountCents: -124_00, counterparty: "Tukku Oy" }],
    });
    const row = statement.transactions[0];
    const paid = await addPurchasePayment(
      buildRequest(
        "POST",
        `/api/purchase-invoices/${invoice.id}/payments`,
        { amount: 124, paidDate: "2026-01-25", transactionId: row.id },
        { cookie }
      ),
      routeContext({ id: invoice.id })
    );
    expect(paid.status).toBe(201);
    expect(ids((await rowsFor(receipt.id)).body)).not.toContain(row.id);
    const refused = await link(row.id, receipt.id);
    expect(refused.status).toBe(409);
    expect((await readJson(refused)).error.code).toBe("TRANSACTION_ALREADY_USED");
  });
});
