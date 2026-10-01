/**
 * OWN-18: the bank is connected through Enable Banking, but Koti said "Ei
 * yhdistettyä tiliä" and the start checklist kept "Yhdistä pankki" undone,
 * because only BankAccount rows were counted. A consent writes BankConnection +
 * ConnectedAccount rows; every "is a bank connected / what is the balance"
 * answer must read those too.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/encryption";
import { addMonths } from "@/lib/bank-balances";
import { helsinkiMonthKey } from "@/lib/validation";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";
import {
  createBankAccountRow,
  createReceipt,
  createStatementWithTransactions,
  createUser,
  resetDatabase,
  type TestUser,
} from "./helpers/factories";

const IBAN_A = "FI2112345600000785";
const IBAN_B = "FI4950009420028730";

let user: TestUser;
let cookie: string;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

async function connect(
  options: Partial<{
    status: string;
    lastError: string | null;
    validUntil: Date;
    aspspName: string;
    accounts: Array<{ iban: string; uid: string; inScope: boolean; balanceCents?: number | null; currency?: string }>;
  }> = {}
) {
  const accounts = options.accounts ?? [{ iban: IBAN_A, uid: "acc-1", inScope: true, balanceCents: 1_234_56 }];
  return prisma.bankConnection.create({
    data: {
      userId: user.id,
      aspspName: options.aspspName ?? "S-Pankki",
      aspspCountry: "FI",
      psuType: "business",
      status: options.status ?? "active",
      sessionIdEnc: encrypt("session-1"),
      validUntil: options.validUntil ?? new Date("2099-01-01T00:00:00.000Z"),
      lastError: options.lastError ?? null,
      lastSuccessAt: new Date(),
      accounts: {
        create: accounts.map((account) => ({
          userId: user.id,
          iban: account.iban,
          label: "Käyttötili",
          providerAccountUid: account.uid,
          inScope: account.inScope,
          currency: account.currency ?? "EUR",
          balanceCents: account.balanceCents === undefined ? null : account.balanceCents,
          balanceAt: account.balanceCents == null ? null : new Date(),
        })),
      },
    },
  });
}

async function koti() {
  const { GET } = await import("@/app/api/dashboard/route");
  return readJson(await GET(buildRequest("GET", "/api/dashboard", undefined, { cookie })));
}

describe("OWN-18: Koti counts a connected bank", () => {
  it("an active consent with an in-scope account is a connected account with its balance", async () => {
    await connect();
    const body = await koti();
    expect(body.bank.accountCount).toBe(1);
    expect(body.bank.totalBalance).toBe(1234.56);
    expect(body.bank.state).toBe("connected");
    expect(body.setup.bank).toBe(true);
  });

  it("accounts left out of bookkeeping are not counted", async () => {
    await connect({
      accounts: [
        { iban: IBAN_A, uid: "acc-1", inScope: true, balanceCents: 100_00 },
        { iban: IBAN_B, uid: "acc-2", inScope: false, balanceCents: 900_00 },
      ],
    });
    const body = await koti();
    expect(body.bank.accountCount).toBe(1);
    expect(body.bank.totalBalance).toBe(100);
  });

  it("an IBAN that is both a ledger account and a connected account counts once", async () => {
    await createBankAccountRow(user.id, { iban: IBAN_A, openingBalanceCents: 500_00 });
    await connect({ accounts: [{ iban: "FI21 1234 5600 0007 85", uid: "acc-1", inScope: true, balanceCents: 510_00 }] });
    const body = await koti();
    expect(body.bank.accountCount).toBe(1);
    // The ledger account is the bookkeeping position; the bank's figure is not added on top.
    expect(body.bank.totalBalance).toBe(500);
  });

  it("the same IBAN under an old and a new consent counts once", async () => {
    await connect({ status: "expired", accounts: [{ iban: IBAN_A, uid: "old", inScope: true, balanceCents: 1_00 }] });
    await connect({ accounts: [{ iban: IBAN_A, uid: "new", inScope: true, balanceCents: 2_00 }] });
    const body = await koti();
    expect(body.bank.accountCount).toBe(1);
    expect(body.bank.totalBalance).toBe(2);
    expect(body.bank.state).toBe("connected");
  });

  it("an expired consent is shown as one to reconnect, not as no bank", async () => {
    await connect({ status: "expired" });
    const body = await koti();
    expect(body.bank.state).toBe("reconnect");
    expect(body.bank.reconnectBank).toBe("S-Pankki");
    expect(body.bank.accountCount).toBe(0);
    expect(body.setup.bank).toBe(true);
  });

  it("an active consent past its validUntil also needs reconnecting", async () => {
    await connect({ validUntil: new Date("2020-01-01T00:00:00.000Z") });
    const body = await koti();
    expect(body.bank.state).toBe("reconnect");
  });

  it("an active consent with no account chosen asks to choose accounts", async () => {
    await connect({ accounts: [{ iban: IBAN_A, uid: "acc-1", inScope: false, balanceCents: 5_00 }] });
    const body = await koti();
    expect(body.bank.state).toBe("unscoped");
    expect(body.bank.accountCount).toBe(0);
    expect(body.setup.bank).toBe(true);
  });

  it("with nothing connected the state is none", async () => {
    const body = await koti();
    expect(body.bank.state).toBe("none");
    expect(body.bank.accountCount).toBe(0);
    expect(body.setup.bank).toBe(false);
  });

  it("a connected account's balance trend comes from its synced rows", async () => {
    await connect({ accounts: [{ iban: IBAN_A, uid: "acc-1", inScope: true, balanceCents: 1_000_00 }] });
    const now = new Date();
    const monthsAgo = (n: number, day = 10) =>
      new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, day));
    const statement = await prisma.statement.create({
      data: {
        userId: user.id,
        fileName: "S-Pankki",
        fileType: "enablebanking",
        filePath: "",
        checksum: `eb:${IBAN_A}:x`,
        periodMonth: "2026-01",
      },
    });
    for (const [n, cents] of [[2, 300_00], [1, -100_00], [0, 200_00]] as const) {
      await prisma.transaction.create({
        data: {
          statementId: statement.id,
          userId: user.id,
          iban: IBAN_A,
          source: "enablebanking",
          date: monthsAgo(n),
          amountCents: cents,
          counterparty: "Testi",
          type: cents > 0 ? "tulo" : "meno",
        },
      });
    }
    const body = await koti();
    // Closing balances: two months ago 900, last month 800, this month 1000 (the bank's figure).
    expect(body.bankTrend.points.map((p: { balance: number }) => p.balance)).toEqual([900, 800, 1000]);
  });

  it("rows older than the chart window still date the history, and a hand-added account without statements adds its opening", async () => {
    await connect({ accounts: [{ iban: IBAN_A, uid: "acc-1", inScope: true, balanceCents: 1_000_00 }] });
    await createBankAccountRow(user.id, { iban: null, name: "Käteiskassa", openingBalanceCents: 50_00, openingDate: "2020-01-01" });
    const now = new Date();
    const statement = await prisma.statement.create({
      data: { userId: user.id, fileName: "S-Pankki", fileType: "enablebanking", filePath: "", checksum: `eb:${IBAN_A}:old`, periodMonth: "2026-01" },
    });
    for (const [n, cents] of [[10, 400_00], [1, -100_00]] as const) {
      await prisma.transaction.create({
        data: {
          statementId: statement.id,
          userId: user.id,
          iban: IBAN_A,
          source: "enablebanking",
          date: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 10)),
          amountCents: cents,
          counterparty: "Testi",
          type: cents > 0 ? "tulo" : "meno",
        },
      });
    }
    const body = await koti();
    // Six months plotted: 1100 until the -100 last month, then 1000; plus 50 cash in every month.
    expect(body.bankTrend.points.map((p: { balance: number }) => p.balance)).toEqual([1150, 1150, 1150, 1150, 1050, 1050]);
  });
});

describe("OWN-18: Pankkitilit counts connected accounts in its total", () => {
  it("/api/bank-accounts reports the connected-only accounts and the combined total", async () => {
    await createBankAccountRow(user.id, { iban: IBAN_B, openingBalanceCents: 50_00 });
    await connect();
    const { GET } = await import("@/app/api/bank-accounts/route");
    const body = await readJson(await GET(buildRequest("GET", "/api/bank-accounts", undefined, { cookie })));
    expect(body.accounts).toHaveLength(1);
    expect(body.connected.accountCount).toBe(1);
    expect(body.combined.accountCount).toBe(2);
    expect(body.combined.totalBalance).toBe(1284.56);
  });
});

describe("OWN-22: Koti's six-month income and expenses follow the month cards' rule", () => {
  it("a month with tiliote rows reads the bank, the others the documents, and the shown month equals the cards", async () => {
    const current = helsinkiMonthKey(new Date());
    const last = addMonths(current, -1);
    await createReceipt(user.id, { type: "meno", date: `${addMonths(current, -2)}-12`, totalAmountCents: 40_00 });
    await createStatementWithTransactions(user.id, {
      periodMonth: last,
      transactions: [
        { date: `${last}-03`, amountCents: 1_000_00 },
        { date: `${last}-04`, amountCents: -250_00 },
      ],
    });
    const { GET } = await import("@/app/api/dashboard/route");
    const body = await readJson(await GET(buildRequest("GET", `/api/dashboard?month=${last}`, undefined, { cookie })));
    // The window ends at the current month whichever month is shown.
    expect(body.cashflow.map((row: { month: string }) => row.month)).toEqual(
      [5, 4, 3, 2, 1, 0].map((back) => addMonths(current, -back))
    );
    expect(body.cashflow[3]).toMatchObject({ income: 0, expenses: 40, source: "kuitit" });
    expect(body.cashflow[4]).toMatchObject({ income: 1000, expenses: 250, source: "tiliote" });
    expect(body.cashflow[4].income).toBe(body.income);
    expect(body.cashflow[4].expenses).toBe(body.expenses);
  });
});
