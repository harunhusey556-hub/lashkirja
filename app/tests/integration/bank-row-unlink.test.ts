import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { POST as batchApprove } from "@/app/api/receipts/batch-approve/route";
import { POST as unlinkRow } from "@/app/api/matching/unlink/route";
import { PUT as setLock } from "@/app/api/period-lock/route";
import { autoGenerateIncomeReceipts } from "@/lib/income-automation";
import { runMatching } from "@/lib/matching";
import {
  createBankAccountRow,
  createReceipt,
  createStatementWithTransactions,
  createUser,
  resetDatabase,
  type TestUser,
} from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

async function saleFixture() {
  const account = await createBankAccountRow(user.id, { name: "Nordea" });
  return {
    statement: await createStatementWithTransactions(user.id, {
      bankAccountId: account.id,
      periodMonth: "2026-09",
      transactions: [{ date: "2026-09-20", amountCents: 125_50, counterparty: "Asiakas Oy" }],
    }),
  };
}

describe("F45: Poista linkitys on an approved sale leaves a row that can be approved again", () => {
  async function approvedSaleRow() {
    const { statement } = await saleFixture();
    const row = statement.transactions[0];
    await runMatching(user.id);
    await autoGenerateIncomeReceipts(user.id, statement.id);
    const draft = await prisma.receipt.findFirstOrThrow({ where: { sourceTransactionId: row.id } });
    const approved = await batchApprove(
      buildRequest("POST", "/api/receipts/batch-approve", { receiptIds: [draft.id] }, { cookie })
    );
    expect((await readJson(approved)).succeeded).toEqual([draft.id]);
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: row.id } })).matchStatus).toBe("confirmed");
    return { row, draft };
  }

  async function unlink(transactionId: string) {
    return unlinkRow(buildRequest("POST", "/api/matching/unlink", { transactionId }, { cookie }));
  }

  it("puts the draft back to pending so the row honestly offers Hyväksy again", async () => {
    const { row, draft } = await approvedSaleRow();
    const response = await unlink(row.id);
    expect(response.status).toBe(200);
    expect((await readJson(response)).restoredSale).toBe(true);
    // At once, with no matching run in between (V29): the row already offers Hyväksy.
    expect(await prisma.transaction.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      matchStatus: "suggested",
      suggestedReceiptId: draft.id,
      receiptId: null,
    });
    await runMatching(user.id);

    expect((await prisma.receipt.findUniqueOrThrow({ where: { id: draft.id } })).reviewStatus).toBe("pending");
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { id: row.id } });
    expect(tx).toMatchObject({ matchStatus: "suggested", suggestedReceiptId: draft.id });

    const again = await batchApprove(
      buildRequest("POST", "/api/receipts/batch-approve", { receiptIds: [draft.id] }, { cookie })
    );
    const body = await readJson(again);
    expect(body.failed).toEqual([]);
    expect(body.succeeded).toEqual([draft.id]);
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: row.id } })).matchStatus).toBe("confirmed");
  });

  it("does not offer a dead-end Hyväksy for an approved draft left behind by the old unlink", async () => {
    const { row, draft } = await approvedSaleRow();
    // The state the old unlink produced: row open, draft still approved.
    await prisma.transaction.update({
      where: { id: row.id },
      data: { receiptId: null, matchStatus: "unmatched", suggestedReceiptId: null, matchScore: null, matchReasons: null },
    });
    await runMatching(user.id);

    const tx = await prisma.transaction.findUniqueOrThrow({ where: { id: row.id } });
    // Healed: the approved sale and its row agree again, nothing is left to tap.
    expect(tx).toMatchObject({ matchStatus: "confirmed", receiptId: draft.id });
  });

  it("refuses to take an approved sale out of a locked month", async () => {
    const { row } = await approvedSaleRow();
    await setLock(buildRequest("PUT", "/api/period-lock", { month: "2026-09" }, { cookie }));
    const response = await unlink(row.id);
    expect(response.status).toBe(409);
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: row.id } })).matchStatus).toBe("confirmed");
  });
});

describe("V29: unlinking an ordinary kuitti is not a restored sale", () => {
  it("leaves the row open and says nothing about a sale", async () => {
    const { statement } = await saleFixture();
    const row = statement.transactions[0];
    const receipt = await createReceipt(user.id, { type: "tulo", date: "2026-09-20", totalAmountCents: 125_50 });
    await prisma.transaction.update({ where: { id: row.id }, data: { receiptId: receipt.id, matchStatus: "confirmed" } });
    const response = await unlinkRow(buildRequest("POST", "/api/matching/unlink", { transactionId: row.id }, { cookie }));
    expect(response.status).toBe(200);
    expect((await readJson(response)).restoredSale).toBe(false);
    expect(await prisma.transaction.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({
      matchStatus: "unmatched",
      suggestedReceiptId: null,
    });
  });
});
