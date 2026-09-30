/**
 * Owner report 2026-09-30: an automatic MobilePay sale offered three look-alike
 * choices, and the newest tiliote sat at the bottom of the list.
 *
 * An income draft belongs to the one bank row it was made from: it is offered
 * there as the only suggestion (one "Hyväksy"), never to other rows, and a bulk
 * "Linkitä kaikki" does not approve it silently. Statements list newest month
 * first, whatever order a bank sync created them in.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { autoGenerateIncomeReceipts } from "@/lib/income-automation";
import { buildInlineCandidates, confirmAllSuggestions, runMatching } from "@/lib/matching";
import { listStatementsForUser } from "@/lib/statement-api";
import { createStatementWithTransactions, createUser, resetDatabase, type TestUser } from "./helpers/factories";

let user: TestUser;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
});

async function mobilePayStatement() {
  const statement = await createStatementWithTransactions(user.id, {
    periodMonth: "2026-09",
    transactions: [
      { date: "2026-09-03", amountCents: 6500, counterparty: "MobilePay" },
      { date: "2026-09-10", amountCents: 6500, counterparty: "MobilePay" },
      { date: "2026-09-17", amountCents: 8000, counterparty: "MobilePay" },
    ],
  });
  const rows = await prisma.transaction.findMany({ where: { statementId: statement.id }, orderBy: { date: "asc" } });
  return { statement, rows };
}

async function suggestionByRow(statementId: string) {
  const rows = await prisma.transaction.findMany({
    where: { statementId },
    select: { id: true, matchStatus: true, suggestedReceipt: { select: { sourceTransactionId: true } } },
  });
  return rows.map((row) => ({
    status: row.matchStatus,
    ownDraft: row.suggestedReceipt?.sourceTransactionId === row.id,
  }));
}

describe("automatic income drafts", () => {
  it("offer each draft on its own row right away", async () => {
    const { statement } = await mobilePayStatement();
    await runMatching(user.id);
    expect(await autoGenerateIncomeReceipts(user.id, statement.id)).toBe(3);

    expect(await suggestionByRow(statement.id)).toEqual([
      { status: "suggested", ownDraft: true },
      { status: "suggested", ownDraft: true },
      { status: "suggested", ownDraft: true },
    ]);
  });

  it("keep their own row through later matching runs, even with look-alike amounts", async () => {
    const { statement } = await mobilePayStatement();
    await autoGenerateIncomeReceipts(user.id, statement.id);
    await runMatching(user.id);
    await runMatching(user.id);

    expect(await suggestionByRow(statement.id)).toEqual([
      { status: "suggested", ownDraft: true },
      { status: "suggested", ownDraft: true },
      { status: "suggested", ownDraft: true },
    ]);
  });

  it("are never offered as a candidate to another row", async () => {
    const { statement } = await mobilePayStatement();
    await autoGenerateIncomeReceipts(user.id, statement.id);
    const other = await createStatementWithTransactions(user.id, {
      periodMonth: "2026-09",
      transactions: [{ date: "2026-09-10", amountCents: 6500, counterparty: "MobilePay" }],
    });
    const [row] = await prisma.transaction.findMany({ where: { statementId: other.id } });
    // A rejected pair leaves this row without its own draft, so it stays open.
    await prisma.transaction.update({ where: { id: row.id }, data: { matchStatus: "unmatched" } });

    const candidates = await buildInlineCandidates(user.id, [row]);
    expect(candidates.get(row.id) ?? []).toEqual([]);
  });

  it("are not approved by a bulk link", async () => {
    const { statement } = await mobilePayStatement();
    await autoGenerateIncomeReceipts(user.id, statement.id);

    expect(await confirmAllSuggestions(user.id, { statementId: statement.id })).toBe(0);
    const approved = await prisma.receipt.count({ where: { userId: user.id, reviewStatus: "approved" } });
    expect(approved).toBe(0);
  });

  it("free the row for a real document once the owner says it is not a sale", async () => {
    const { statement, rows } = await mobilePayStatement();
    await autoGenerateIncomeReceipts(user.id, statement.id);
    const draft = await prisma.receipt.findFirstOrThrow({ where: { sourceTransactionId: rows[0].id } });
    await prisma.matchRejection.create({ data: { transactionId: rows[0].id, receiptId: draft.id } });

    await runMatching(user.id);
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: rows[0].id } });
    expect(row.suggestedReceiptId).not.toBe(draft.id);
  });
});

describe("statement list order", () => {
  it("puts the newest month first, not the first one created", async () => {
    // A bank sync creates months in the order the bank returns rows.
    for (const month of ["2026-09", "2026-07", "2026-08"]) {
      await createStatementWithTransactions(user.id, {
        periodMonth: month,
        transactions: [{ date: `${month}-05`, amountCents: -1000 }],
      });
    }
    const list = await listStatementsForUser(user.id);
    // enrichStatements keeps every Statement field at runtime; its type lists only what it adds.
    const months = list.map((statement) => (statement as { periodMonth?: string | null }).periodMonth);
    expect(months).toEqual(["2026-09", "2026-08", "2026-07"]);
  });
});
