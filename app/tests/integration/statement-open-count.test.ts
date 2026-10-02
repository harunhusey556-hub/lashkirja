import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { GET as listStatements } from "@/app/api/statements/route";
import { GET as statementCounts } from "@/app/api/statements/counts/route";
import { feedRows, needsAction } from "@/lib/bank-feed";
import type { StatementData } from "@/lib/statement-client";
import {
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

describe("GET /api/statements/counts", () => {
  it("counts the same open rows as the full feed, without loading it", async () => {
    const statement = await createStatementWithTransactions(user.id, {
      periodMonth: "2026-09",
      transactions: [
        { date: "2026-09-01", amountCents: -1_000, counterparty: "Puuttuu Oy" },
        { date: "2026-09-02", amountCents: -2_000, counterparty: "Ehdotettu Oy" },
        { date: "2026-09-03", amountCents: -3_000, counterparty: "Kohdistettu Oy" },
        { date: "2026-09-04", amountCents: -4_000, counterparty: "Ohitettu Oy" },
        { date: "2026-09-05", amountCents: -5_000, counterparty: "Oma tili" },
        { date: "2026-09-06", amountCents: -6_000, counterparty: "Palkka" },
      ],
    });
    const [missing, suggested, confirmed, ignored, transfer, salary] = statement.transactions.sort(
      (a, b) => a.amountCents - b.amountCents
    ).reverse();
    const receipt = await createReceipt(user.id, { vendor: "Ehdotettu Oy", totalAmountCents: 2_000, date: "2026-09-02" });
    const linked = await createReceipt(user.id, { vendor: "Kohdistettu Oy", totalAmountCents: 3_000, date: "2026-09-03" });
    await prisma.transaction.update({ where: { id: suggested.id }, data: { matchStatus: "suggested", suggestedReceiptId: receipt.id } });
    await prisma.transaction.update({ where: { id: confirmed.id }, data: { matchStatus: "confirmed", receiptId: linked.id } });
    await prisma.transaction.update({ where: { id: ignored.id }, data: { matchStatus: "ignored" } });
    await prisma.transaction.update({ where: { id: transfer.id }, data: { type: "oma_siirto" } });
    await prisma.transaction.update({ where: { id: salary.id }, data: { type: "palkka" } });
    expect(missing.counterparty).toBe("Puuttuu Oy");

    const counts = await readJson<{ open: number }>(
      await statementCounts(buildRequest("GET", "/api/statements/counts", undefined, { cookie }))
    );
    const list = await readJson<{ statements: StatementData[] }>(
      await listStatements(buildRequest("GET", "/api/statements", undefined, { cookie }))
    );
    const expected = feedRows(list.statements).filter(needsAction).length;
    expect(expected).toBe(2);
    expect(counts.open).toBe(expected);
  });

  it("refuses without a session", async () => {
    const response = await statementCounts(buildRequest("GET", "/api/statements/counts"));
    expect(response.status).toBe(401);
  });
});
