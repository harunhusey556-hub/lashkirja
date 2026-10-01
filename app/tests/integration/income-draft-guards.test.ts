/**
 * Live-use test 2026-09-30 (F50 G18): only a settlement from a known provider
 * becomes a "recognised sale" draft, and a draft the owner deleted stays
 * deleted when matching is run again.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { autoGenerateIncomeReceipts } from "@/lib/income-automation";
import { runMatching } from "@/lib/matching";
import { POST as rerunMatching } from "@/app/api/matching/run/route";
import { DELETE as deleteReceipt } from "@/app/api/receipts/[id]/route";
import { POST as batchDelete } from "@/app/api/receipts/batch-delete/route";
import { createStatementWithTransactions, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

async function statement(rows: Array<{ counterparty: string; amountCents: number }>) {
  return createStatementWithTransactions(user.id, {
    periodMonth: "2026-09",
    transactions: rows.map((row, index) => ({ date: `2026-09-0${index + 1}`, ...row })),
  });
}

describe("F50: a recognised sale is a known settlement provider, nothing else", () => {
  it("drafts the MobilePay row and leaves the other incoming rows as plain rows", async () => {
    const { id } = await statement([
      { counterparty: "MobilePay", amountCents: 5200 },
      { counterparty: "Toinen Asiakas Oy", amountCents: 123_456 },
      { counterparty: "Oma lainanotto", amountCents: 500_000 },
    ]);
    expect(await autoGenerateIncomeReceipts(user.id, id)).toBe(1);

    const rows = await prisma.transaction.findMany({ where: { statementId: id }, orderBy: { date: "asc" } });
    expect(rows.map((row) => row.matchStatus)).toEqual(["suggested", "unmatched", "unmatched"]);
    const drafts = await prisma.receipt.findMany({ where: { userId: user.id, source: "auto_income" } });
    expect(drafts.map((draft) => draft.vendor)).toEqual(["MobilePay Myyntitilitys"]);
  });

  it("takes back an old draft of an unknown payer that nobody has touched, and keeps an edited one", async () => {
    const { id } = await statement([
      { counterparty: "Vanha Asiakas Oy", amountCents: 10_000 },
      { counterparty: "Muokattu Oy", amountCents: 20_000 },
    ]);
    const [plain, edited] = await prisma.transaction.findMany({ where: { statementId: id }, orderBy: { date: "asc" } });
    const make = async (tx: typeof plain, vendor: string, notes: string) => {
      const draft = await prisma.receipt.create({
        data: {
          userId: user.id,
          type: "tulo",
          vendor,
          date: tx.date ?? new Date(),
          totalAmountCents: tx.amountCents,
          category: "myynti",
          notes,
          filePath: "auto-generated",
          fileName: "Myyntitosite_luonnos.txt",
          source: "auto_income",
          sourceTransactionId: tx.id,
          reviewStatus: "pending",
        },
      });
      await prisma.transaction.update({
        where: { id: tx.id },
        data: { matchStatus: "suggested", suggestedReceiptId: draft.id, matchScore: 1 },
      });
      return draft;
    };
    await make(plain, "Vanha Asiakas Oy", "Tulo (Automaattinen luonnos) — LUONNOS. Tarkista summa ja ALV ennen hyväksyntää.");
    const keep = await make(edited, "Muokattu Oy", "Omat muistiinpanot: tämä on oikea myynti.");

    await autoGenerateIncomeReceipts(user.id, id);

    const left = await prisma.receipt.findMany({ where: { userId: user.id, source: "auto_income" } });
    expect(left.map((draft) => draft.id)).toEqual([keep.id]);
    const rows = await prisma.transaction.findMany({ where: { statementId: id }, orderBy: { date: "asc" } });
    expect(rows[0]).toMatchObject({ matchStatus: "unmatched", suggestedReceiptId: null });
    expect(rows[1]).toMatchObject({ matchStatus: "suggested", suggestedReceiptId: keep.id });
  });
});

describe("G18: a draft the owner deleted does not come back", () => {
  async function mobilePayDraft() {
    const { id } = await statement([{ counterparty: "MobilePay", amountCents: 4100 }]);
    await autoGenerateIncomeReceipts(user.id, id);
    const draft = await prisma.receipt.findFirstOrThrow({ where: { userId: user.id, source: "auto_income" } });
    return { statementId: id, draft };
  }
  const draftsOfRow = (transactionId: string | null) =>
    prisma.receipt.count({ where: { userId: user.id, sourceTransactionId: transactionId } });

  it("stays deleted after the matching rerun", async () => {
    const { draft } = await mobilePayDraft();
    const response = await deleteReceipt(
      buildRequest("DELETE", `/api/receipts/${draft.id}`, undefined, { cookie }),
      routeContext({ id: draft.id })
    );
    expect(response.status).toBe(200);

    const rerun = await rerunMatching(buildRequest("POST", "/api/matching/run", undefined, { cookie }));
    const body = await readJson(rerun);
    expect(await draftsOfRow(draft.sourceTransactionId)).toBe(0);
    // Nothing was linked, and nothing is told as linked.
    expect(body.autoConfirmed).toBe(0);
    expect(body.draftsCreated).toBe(0);
    const row = await prisma.transaction.findFirstOrThrow({ where: { id: draft.sourceTransactionId! } });
    expect(row.matchStatus).toBe("unmatched");
  });

  it("stays deleted after a bulk delete and a bank-sync style drafting run too", async () => {
    const { statementId, draft } = await mobilePayDraft();
    const response = await batchDelete(
      buildRequest("POST", "/api/receipts/batch-delete", { receiptIds: [draft.id] }, { cookie })
    );
    expect((await readJson(response)).deletedCount).toBe(1);

    await runMatching(user.id);
    expect(await autoGenerateIncomeReceipts(user.id, statementId)).toBe(0);
    expect(await draftsOfRow(draft.sourceTransactionId)).toBe(0);
  });

  it("a row the owner dismissed does not stop a fresh row from being drafted", async () => {
    const { draft } = await mobilePayDraft();
    await deleteReceipt(buildRequest("DELETE", `/api/receipts/${draft.id}`, undefined, { cookie }), routeContext({ id: draft.id }));
    const other = await statement([{ counterparty: "MobilePay", amountCents: 900 }]);
    expect(await autoGenerateIncomeReceipts(user.id, other.id)).toBe(1);
  });

  it("reports the drafts a rerun made as drafts, not as links", async () => {
    await statement([{ counterparty: "MobilePay", amountCents: 7000 }]);
    const body = await readJson(await rerunMatching(buildRequest("POST", "/api/matching/run", undefined, { cookie })));
    expect(body.draftsCreated).toBe(1);
    expect(body.autoConfirmed).toBe(0);
  });
});

describe("M1-1: an old draft the owner has changed is never taken back", () => {
  const AUTO_NOTE = "Tulo (Automaattinen luonnos) — LUONNOS. Tarkista summa ja ALV ennen hyväksyntää.";

  async function legacyDraft(counterparty: string, amountCents: number, vatDetails: string | null = null) {
    const { id } = await statement([{ counterparty, amountCents }]);
    const tx = await prisma.transaction.findFirstOrThrow({ where: { statementId: id } });
    const draft = await prisma.receipt.create({
      data: {
        userId: user.id,
        type: "tulo",
        vendor: counterparty,
        date: tx.date ?? new Date(),
        totalAmountCents: tx.amountCents,
        vatDetails,
        category: "myynti",
        notes: AUTO_NOTE,
        filePath: "auto-generated",
        fileName: "Myyntitosite_luonnos.txt",
        source: "auto_income",
        sourceTransactionId: tx.id,
        reviewStatus: "pending",
      },
    });
    await prisma.transaction.update({
      where: { id: tx.id },
      data: { matchStatus: "suggested", suggestedReceiptId: draft.id, matchScore: 1 },
    });
    return { statementId: id, draft, tx };
  }

  async function runs(statementId: string) {
    await autoGenerateIncomeReceipts(user.id, statementId);
    await rerunMatching(buildRequest("POST", "/api/matching/run", undefined, { cookie }));
  }

  for (const [label, change] of [
    ["category", { category: "palvelut" }],
    ["VAT", { vatDetails: JSON.stringify([{ rate: 10, amount: 3 }]) }],
    ["amount", { totalAmountCents: 9_000 }],
    ["type", { type: "meno" }],
  ] as const) {
    it(`keeps a draft whose ${label} was edited and saved without approving, notes untouched`, async () => {
      const { statementId, draft } = await legacyDraft("Muokkaaja Oy", 10_000);
      await prisma.receipt.update({ where: { id: draft.id }, data: change });
      await runs(statementId);
      const left = await prisma.receipt.findUnique({ where: { id: draft.id } });
      expect(left).not.toBeNull();
      expect(left).toMatchObject({ notes: AUTO_NOTE, reviewStatus: "pending" });
    });
  }

  it("keeps a draft that was re-saved even when every value is still the generated one", async () => {
    const { statementId, draft } = await legacyDraft("Tallentaja Oy", 10_000);
    // Made an hour ago; the owner's save (even of the same values) is "now".
    await prisma.receipt.update({ where: { id: draft.id }, data: { createdAt: new Date(Date.now() - 3_600_000) } });
    await prisma.receipt.update({ where: { id: draft.id }, data: { notes: AUTO_NOTE } });
    await runs(statementId);
    expect(await prisma.receipt.findUnique({ where: { id: draft.id } })).not.toBeNull();
  });

  it("still takes back one nobody touched, VAT included", async () => {
    const { statementId, draft, tx } = await legacyDraft("Koskematon Oy", 12_400, JSON.stringify([{ rate: 25.5, amount: 25.2 }]));
    await runs(statementId);
    expect(await prisma.receipt.findUnique({ where: { id: draft.id } })).toBeNull();
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } });
    expect(row).toMatchObject({ matchStatus: "unmatched", suggestedReceiptId: null });
  });
});
