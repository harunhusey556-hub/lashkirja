import { beforeEach, describe, expect, it } from "vitest";
import { POST as confirm } from "@/app/api/matching/confirm/route";
import { prisma } from "@/lib/db";
import { createReceipt, createStatementWithTransactions, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

/** Audit 2026-10-09: linking a second receipt to a bank row took the row from the first silently. */

let user: TestUser;
let cookie: string;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

const link = (transactionId: string, receiptId: string) =>
  confirm(buildRequest("POST", "/api/matching/confirm", { transactionId, receiptId }, { cookie }));

describe("POST /api/matching/confirm on a row that has a receipt", () => {
  it("refuses another receipt and leaves the first one linked", async () => {
    const first = await createReceipt(user.id, { totalAmountCents: 2_500, date: "2026-09-03" });
    const second = await createReceipt(user.id, { totalAmountCents: 2_500, date: "2026-09-03", vendor: "Toinen Oy" });
    const statement = await createStatementWithTransactions(user.id, {
      periodMonth: "2026-09",
      transactions: [{ date: "2026-09-03", amountCents: -2_500, counterparty: "Tukku Oy" }],
    });
    const row = statement.transactions[0];
    expect((await link(row.id, first.id)).status).toBe(200);
    const again = await link(row.id, second.id);
    expect(again.status).toBe(409);
    const refused = await readJson(again);
    expect(JSON.stringify(refused)).toContain("toiseen kuittiin");
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: row.id } })).receiptId).toBe(first.id);
    // The same pair again is fine (a repeated tap).
    expect((await link(row.id, first.id)).status).toBe(200);
  });
});
