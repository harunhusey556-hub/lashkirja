import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/encryption";
import type { EnableBankingClient } from "@/lib/enablebanking/client";
import type { EbTransaction } from "@/lib/enablebanking/mapping";
import { syncBankConnection } from "@/lib/enablebanking/sync";
import { GET as listStatements, POST as uploadStatement } from "@/app/api/statements/route";
import { GET as openCount } from "@/app/api/statements/counts/route";
import { GET as syncVersion } from "@/app/api/sync/version/route";
import { createBankAccountRow, createReceipt, createStatementWithTransactions, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildFormRequest, buildRequest, readJson, sessionCookie } from "./helpers/http";

/**
 * W18: the paged bank feed, the statement summary and the freshness contract
 * (GET /api/sync/version and the dataVersion bumped by the DataVersion triggers).
 */
const IBAN = "FI2112345600000785";
let user: TestUser;
let cookie: string;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

const get = (url: string) => listStatements(buildRequest("GET", url, undefined, { cookie }));
const version = async () => readJson(await syncVersion(buildRequest("GET", "/api/sync/version", undefined, { cookie })));

/** 130 rows over three months: shared days (id tie-break) and two rows without a date. */
async function seedLedger() {
  const account = await createBankAccountRow(user.id, { name: "Käyttötili", iban: IBAN, isDefault: true });
  for (const month of ["2026-07", "2026-08", "2026-09"]) {
    await createStatementWithTransactions(user.id, {
      bankAccountId: account.id,
      periodMonth: month,
      transactions: Array.from({ length: 43 }, (_, i) => ({
        date: `${month}-${String((i % 9) + 1).padStart(2, "0")}`,
        amountCents: i % 4 === 0 ? 1000 + i : -(500 + i),
      })),
    });
  }
  await createStatementWithTransactions(user.id, {
    bankAccountId: account.id,
    periodMonth: "2026-09",
    transactions: [{ date: null, amountCents: -100 }, { date: null, amountCents: -200 }],
  });
  return account;
}

describe("paged bank feed", () => {
  it("walks every row once, newest first, and stops with a null cursor", async () => {
    await seedLedger();
    const seen: string[] = [];
    const dates: Array<string | null> = [];
    let cursor = "";
    let total = -1;
    for (let pages = 0; pages < 10; pages++) {
      const response = await get(`/api/statements?cursor=${encodeURIComponent(cursor)}&limit=50`);
      expect(response.status).toBe(200);
      expect(response.headers.get("etag")).toBeTruthy();
      const body = await readJson(response);
      total = body.total;
      for (const row of body.transactions) {
        seen.push(row.id);
        dates.push(row.date);
        expect(row.periodMonth).toMatch(/^2026-0[789]$/);
        expect(typeof row.amount).toBe("number");
        expect(Array.isArray(row.matchCandidates)).toBe(true);
      }
      if (!body.nextCursor) break;
      cursor = body.nextCursor;
    }
    expect(total).toBe(131);
    expect(seen).toHaveLength(131);
    expect(new Set(seen).size).toBe(131);
    // Dated rows newest first, the undated ones last.
    const dated = dates.filter((d): d is string => d !== null);
    expect(dated).toEqual([...dated].sort().reverse());
    expect(dates.slice(-2)).toEqual([null, null]);
  });

  it("a row stored between two pages neither shifts the next page nor repeats a row", async () => {
    const account = await seedLedger();
    const first = await readJson(await get("/api/statements?cursor="));
    expect(first.transactions).toHaveLength(50);
    const added = await createStatementWithTransactions(user.id, {
      bankAccountId: account.id,
      periodMonth: "2026-10",
      transactions: [{ date: "2026-10-05", amountCents: -999 }],
    });
    const second = await readJson(await get(`/api/statements?cursor=${first.nextCursor}`));
    const firstIds = new Set(first.transactions.map((row: { id: string }) => row.id));
    expect(second.transactions).toHaveLength(50);
    expect(second.transactions.some((row: { id: string }) => firstIds.has(row.id))).toBe(false);
    expect(second.transactions.some((row: { id: string }) => row.id === added.transactions[0].id)).toBe(false);
    expect(second.transactions[0].date <= first.transactions[49].date).toBe(true);
  });

  it("filters by month and refuses a forged cursor or limit", async () => {
    await seedLedger();
    const august = await readJson(await get("/api/statements?cursor=&month=2026-08"));
    expect(august.total).toBe(43);
    expect(august.transactions.every((row: { periodMonth: string }) => row.periodMonth === "2026-08")).toBe(true);
    expect((await get("/api/statements?cursor=not-a-cursor")).status).toBe(400);
    expect((await get("/api/statements?limit=500")).status).toBe(400);
  });

  it("answers 304 to the ETag it gave while nothing changed", async () => {
    await seedLedger();
    const first = await get("/api/statements");
    const tag = first.headers.get("etag")!;
    expect(first.headers.get("cache-control")).toContain("no-cache");
    const again = await listStatements(buildRequest("GET", "/api/statements", undefined, { cookie, headers: { "if-none-match": tag } }));
    expect(again.status).toBe(304);
    await createReceipt(user.id, { totalAmountCents: 500 });
    await prisma.transaction.updateMany({ where: { userId: null }, data: { message: "muutettu" } });
    const changed = await listStatements(buildRequest("GET", "/api/statements", undefined, { cookie, headers: { "if-none-match": tag } }));
    expect(changed.status).toBe(200);
  });
});

describe("statement summary", () => {
  it("counts and totals equal the paged rows and the full list", async () => {
    await seedLedger();
    const summary = await readJson(await get("/api/statements?view=summary"));
    const full = await readJson(await get("/api/statements"));
    const feed = await readJson(await get("/api/statements?cursor="));
    expect(summary.statements.map((s: { id: string }) => s.id)).toEqual(full.statements.map((s: { id: string }) => s.id));
    expect(summary.statements[0].transactions).toBeUndefined();
    for (const [index, statement] of summary.statements.entries()) {
      expect(statement.totals).toEqual(full.statements[index].totals);
    }
    const txCount = summary.statements.reduce((sum: number, s: { totals: { txCount: number } }) => sum + s.totals.txCount, 0);
    expect(txCount).toBe(feed.total);
    const open = await readJson(await openCount(buildRequest("GET", "/api/statements/counts", undefined, { cookie })));
    const summed = summary.statements.reduce((sum: number, s: { openCount: number }) => sum + s.openCount, 0);
    expect(summed).toBe(open.open);
  });
});

describe("freshness contract", () => {
  it("starts at 0 and moves on a receipt save, a match and a delete", async () => {
    const empty = await version();
    expect(empty).toMatchObject({ dataVersion: 0, bank: { lastChangeAt: null, accounts: [] }, receipts: { lastChangeAt: null } });

    const receipt = await createReceipt(user.id, { totalAmountCents: 1234 });
    const afterReceipt = await version();
    expect(afterReceipt.dataVersion).toBeGreaterThan(0);
    expect(afterReceipt.receipts.lastChangeAt).not.toBeNull();

    const statement = await createStatementWithTransactions(user.id, { transactions: [{ date: "2026-09-01", amountCents: -1234 }] });
    const afterRows = await version();
    expect(afterRows.dataVersion).toBeGreaterThan(afterReceipt.dataVersion);
    expect(afterRows.bank.lastChangeAt).not.toBeNull();

    await prisma.transaction.update({ where: { id: statement.transactions[0].id }, data: { receiptId: receipt.id, matchStatus: "confirmed" } });
    const afterMatch = await version();
    expect(afterMatch.dataVersion).toBeGreaterThan(afterRows.dataVersion);

    await prisma.statement.delete({ where: { id: statement.id } });
    expect((await version()).dataVersion).toBeGreaterThan(afterMatch.dataVersion);
  });

  it("another user's writes do not move this user's version", async () => {
    await createReceipt(user.id);
    const mine = (await version()).dataVersion;
    const other = await createUser();
    await createReceipt(other.id);
    await createStatementWithTransactions(other.id, { transactions: [{ date: "2026-09-01", amountCents: -1 }] });
    expect((await version()).dataVersion).toBe(mine);
  });

  it("a statement import answers with the new version, and the version endpoint agrees", async () => {
    await createBankAccountRow(user.id, { name: "Käyttötili", iban: IBAN, isDefault: true });
    const before = (await version()).dataVersion;
    const csv = "Kirjauspäivä;Summa;Saaja\n01.09.2026;-35,90;K-Market Kamppi\n15.09.2026;-12,50;Spotify\n";
    const form = new FormData();
    form.set("file", new File([`IBAN ${IBAN}\n${csv}`], "tiliote.csv", { type: "text/csv" }));
    const response = await uploadStatement(buildFormRequest("/api/statements", form, { cookie }));
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.dataVersion).toBeGreaterThan(before);
    expect(body.bank.accounts).toEqual(expect.arrayContaining([expect.objectContaining({ iban: IBAN })]));
    expect((await version()).dataVersion).toBe(body.dataVersion);
  });

  it("a bank sync moves the version and the fresh balance is in the version answer", async () => {
    await createBankAccountRow(user.id, { name: "Käyttötili", iban: IBAN, isDefault: true });
    const connection = await prisma.bankConnection.create({
      data: {
        userId: user.id,
        aspspName: "Testipankki",
        aspspCountry: "FI",
        psuType: "business",
        status: "active",
        sessionIdEnc: encrypt("session-1"),
        validUntil: new Date("2099-01-01T00:00:00.000Z"),
        accounts: { create: [{ userId: user.id, iban: IBAN, label: "Käyttötili", providerAccountUid: "acc-1", inScope: true }] },
      },
    });
    const before = await version();
    const rows: EbTransaction[] = [
      {
        status: "BOOK",
        entry_reference: "R1",
        booking_date: "2026-09-03",
        credit_debit_indicator: "DBIT",
        transaction_amount: { currency: "EUR", amount: "12.00" },
        creditor: { name: "Kauppa Oy" },
      },
    ];
    const client = {
      getSession: async () => ({ status: "AUTHORIZED" }),
      getAccountBalances: async () => [
        { balance_type: "CLBD", balance_amount: { currency: "EUR", amount: "4321.00" }, reference_date: "2026-09-30" },
      ],
      getAccountTransactions: async () => ({ transactions: rows, continuationKey: null }),
    } as unknown as EnableBankingClient;
    await syncBankConnection(user.id, connection.id, { attended: true, client });

    const after = await version();
    expect(after.dataVersion).toBeGreaterThan(before.dataVersion);
    const line = after.bank.accounts.find((account: { iban: string }) => account.iban === IBAN);
    expect(line.bankAccountId).toBeTruthy();
    expect(line.lastSyncAt).not.toBeNull();
    const stored = await prisma.connectedAccount.findFirstOrThrow({ where: { connectionId: connection.id } });
    expect(line.balanceCents).toBe(stored.balanceCents);
  });
});
