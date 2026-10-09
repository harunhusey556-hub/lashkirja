/**
 * The owner changes "Mistä lähtien haetaan?" after the bank is connected
 * (PATCH /api/bank/connections/{id} { historyFrom }). An earlier day makes the
 * next sync read the older window once, never duplicating what is stored; a
 * later day deletes nothing; a closed month is never written.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/encryption";
import { GET as listConnections } from "@/app/api/bank/connections/route";
import { PATCH as patchConnection } from "@/app/api/bank/connections/[id]/route";
import {
  EnableBankingError,
  type EnableBankingClient,
  type TransactionQuery,
} from "@/lib/enablebanking/client";
import type { EbTransaction } from "@/lib/enablebanking/mapping";
import { syncBankConnection } from "@/lib/enablebanking/sync";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

const IBAN_A = "FI2112345600000785";
const IBAN_B = "FI4950009420028730";
const DAY_MS = 24 * 60 * 60 * 1000;

let user: TestUser;
let cookie: string;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

/** "YYYY-MM-DD", `n` days before today (UTC, as the sync counts days). */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY_MS).toISOString().slice(0, 10);
}

function firstDayOfNextMonth(day: string): string {
  const [year, month] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
}

function row(id: string, date: string, amount = "10.00"): EbTransaction {
  return {
    status: "BOOK",
    entry_reference: id,
    booking_date: date,
    credit_debit_indicator: "DBIT",
    transaction_amount: { currency: "EUR", amount },
    creditor: { name: `Kauppa ${id}` },
  };
}

/**
 * A bank that answers from a ledger by booking date, like the real one, and
 * remembers every query. `oldest` makes it refuse an older start.
 */
function fakeBank(ledger: Record<string, EbTransaction[]>, options: { oldest?: string } = {}) {
  const queries: TransactionQuery[] = [];
  const client = {
    getSession: async () => ({ status: "AUTHORIZED" }),
    getAccountBalances: async () => [],
    getAccountTransactions: async (query: TransactionQuery) => {
      queries.push(query);
      if (options.oldest && query.dateFrom && query.dateFrom < options.oldest) {
        throw new EnableBankingError("Wrong transactions period", 400, "WRONG_TRANSACTIONS_PERIOD");
      }
      const rows = (ledger[query.accountUid] ?? []).filter((tx) => {
        const day = tx.booking_date ?? "";
        if (query.dateFrom && day < query.dateFrom) return false;
        if (query.dateTo && day > query.dateTo) return false;
        return true;
      });
      return { transactions: rows, continuationKey: null };
    },
  } as unknown as EnableBankingClient;
  return { client, queries };
}

async function createConnection(
  input: {
    historyFrom?: string | null;
    historyLimitDays?: number | null;
    userId?: string;
    accounts?: Array<{ iban: string; uid: string; inScope: boolean }>;
  } = {}
) {
  const accounts = input.accounts ?? [{ iban: IBAN_A, uid: "acc-1", inScope: true }];
  const owner = input.userId ?? user.id;
  return prisma.bankConnection.create({
    data: {
      userId: owner,
      aspspName: "Testipankki",
      aspspCountry: "FI",
      psuType: "business",
      status: "active",
      sessionIdEnc: encrypt("session-1"),
      validUntil: new Date("2099-01-01T00:00:00.000Z"),
      historyFrom: input.historyFrom ?? null,
      historyLimitDays: input.historyLimitDays ?? null,
      accounts: {
        create: accounts.map((account) => ({
          userId: owner,
          iban: account.iban,
          label: "Käyttötili",
          providerAccountUid: account.uid,
          inScope: account.inScope,
        })),
      },
    },
    include: { accounts: true },
  });
}

async function patch(id: string, body: unknown, as = cookie) {
  const response = await patchConnection(
    buildRequest("PATCH", `/api/bank/connections/${id}`, body, { cookie: as }),
    routeContext({ id })
  );
  return { status: response.status, body: await readJson(response) };
}

async function storedDays(): Promise<string[]> {
  const rows = await prisma.transaction.findMany({ where: { userId: user.id }, select: { date: true } });
  return rows.map((stored) => stored.date!.toISOString().slice(0, 10)).sort();
}

/** The queries that read older history than an incremental sync does. */
function olderQueries(queries: TransactionQuery[], before: string) {
  return queries.filter((query) => query.strategy === "longest" || (query.dateFrom ?? "") < before);
}

describe("PATCH historyFrom to an earlier day: the next sync backfills the older window once", () => {
  it("fetches historyFrom..earliest already fetched, imports only the missing rows, then stops", async () => {
    const connection = await createConnection({ historyFrom: daysAgo(60) });
    const ledger = {
      "acc-1": [
        row("old-1", daysAgo(100)),
        row("old-2", daysAgo(70)),
        row("edge", daysAgo(60)),
        row("mid", daysAgo(30)),
        row("new", daysAgo(2)),
      ],
    };

    const first = fakeBank(ledger);
    const initial = await syncBankConnection(user.id, connection.id, { attended: false, client: first.client });
    expect(initial.imported).toBe(3);
    expect(first.queries[0]).toMatchObject({ dateFrom: daysAgo(60) });

    const changed = await patch(connection.id, { historyFrom: daysAgo(120) });
    expect(changed.status).toBe(200);
    expect(changed.body.connection.historyFrom).toBe(daysAgo(120));

    const second = fakeBank(ledger);
    const backfill = await syncBankConnection(user.id, connection.id, { attended: false, client: second.client });
    const older = olderQueries(second.queries, daysAgo(10));
    expect(older).toHaveLength(1);
    expect(older[0]).toMatchObject({ accountUid: "acc-1", dateFrom: daysAgo(120), dateTo: daysAgo(60) });
    expect(older[0].strategy).toBeUndefined();
    expect(backfill.imported).toBe(2);
    expect(await storedDays()).toEqual([daysAgo(100), daysAgo(70), daysAgo(60), daysAgo(30), daysAgo(2)]);

    const third = fakeBank(ledger);
    const again = await syncBankConnection(user.id, connection.id, { attended: false, client: third.client });
    expect(olderQueries(third.queries, daysAgo(10))).toHaveLength(0);
    expect(again.imported).toBe(0);
    expect(await prisma.transaction.count({ where: { userId: user.id } })).toBe(5);

    const listed = await readJson(await listConnections(buildRequest("GET", "/api/bank/connections", undefined, { cookie })));
    expect(listed.connections[0].historyFrom).toBe(daysAgo(120));
  });

  it("an account added to the books later reads its history from the chosen day on its first sync", async () => {
    const connection = await createConnection({
      historyFrom: daysAgo(60),
      accounts: [
        { iban: IBAN_A, uid: "acc-1", inScope: true },
        { iban: IBAN_B, uid: "acc-2", inScope: false },
      ],
    });
    const ledger = {
      "acc-1": [row("a1", daysAgo(40))],
      "acc-2": [row("b-old", daysAgo(90)), row("b1", daysAgo(50)), row("b2", daysAgo(1))],
    };
    await syncBankConnection(user.id, connection.id, { attended: false, client: fakeBank(ledger).client });

    const second = connection.accounts.find((account) => account.providerAccountUid === "acc-2")!;
    const scoped = await patch(connection.id, { accounts: [{ id: second.id, inScope: true }] });
    expect(scoped.status).toBe(200);

    const bank = fakeBank(ledger);
    const result = await syncBankConnection(user.id, connection.id, { attended: false, client: bank.client });
    expect(result.imported).toBe(2);
    const older = olderQueries(bank.queries, daysAgo(10));
    expect(older).toHaveLength(1);
    expect(older[0]).toMatchObject({ accountUid: "acc-2", dateFrom: daysAgo(60) });
    const ibanB = await prisma.transaction.count({ where: { userId: user.id, iban: IBAN_B } });
    expect(ibanB).toBe(2);
  });
});

describe("PATCH historyFrom to a later day deletes nothing", () => {
  it("keeps every imported row and fetches nothing older", async () => {
    const connection = await createConnection({ historyFrom: daysAgo(60) });
    const ledger = { "acc-1": [row("a", daysAgo(50)), row("b", daysAgo(20)), row("c", daysAgo(3))] };
    await syncBankConnection(user.id, connection.id, { attended: false, client: fakeBank(ledger).client });
    expect(await prisma.transaction.count({ where: { userId: user.id } })).toBe(3);

    const changed = await patch(connection.id, { historyFrom: daysAgo(10) });
    expect(changed.status).toBe(200);
    expect(changed.body.connection.historyFrom).toBe(daysAgo(10));

    const bank = fakeBank(ledger);
    await syncBankConnection(user.id, connection.id, { attended: false, client: bank.client });
    expect(olderQueries(bank.queries, daysAgo(10))).toHaveLength(0);
    expect(await prisma.transaction.count({ where: { userId: user.id } })).toBe(3);
  });
});

describe("PATCH historyFrom is refused when the bank cannot give it", () => {
  it("a day in the future is a 400 in Finnish and changes nothing", async () => {
    const connection = await createConnection({ historyFrom: daysAgo(60) });
    const tomorrow = new Date(Date.now() + 2 * DAY_MS).toISOString().slice(0, 10);
    const refused = await patch(connection.id, { historyFrom: tomorrow });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/tulevaisuudessa/);
    const stored = await prisma.bankConnection.findUnique({ where: { id: connection.id } });
    expect(stored?.historyFrom).toBe(daysAgo(60));
  });

  it("a malformed day is a 400", async () => {
    const connection = await createConnection();
    const refused = await patch(connection.id, { historyFrom: "2026-02-31" });
    expect(refused.status).toBe(400);
    expect(typeof refused.body.error).toBe("string");
  });

  it("a day beyond the bank's known limit is a 400 that names the limit; inside it is fine", async () => {
    const connection = await createConnection({ historyLimitDays: 395 });
    const refused = await patch(connection.id, { historyFrom: daysAgo(500) });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("Pankki antaa tapahtumat enintään 13 kuukauden ajalta.");

    const accepted = await patch(connection.id, { historyFrom: daysAgo(300) });
    expect(accepted.status).toBe(200);
    expect(accepted.body.connection.historyLimitDays).toBe(395);
  });

  it("a bank that refuses the old start: the sync takes what it gives, learns the limit and does not ask again", async () => {
    const connection = await createConnection({ historyFrom: daysAgo(60) });
    const ledger = {
      "acc-1": [row("ancient", daysAgo(450)), row("year", daysAgo(300)), row("recent", daysAgo(30))],
    };
    await syncBankConnection(user.id, connection.id, {
      attended: false,
      client: fakeBank(ledger, { oldest: daysAgo(380) }).client,
    });

    expect((await patch(connection.id, { historyFrom: daysAgo(500) })).status).toBe(200);
    const bank = fakeBank(ledger, { oldest: daysAgo(380) });
    const result = await syncBankConnection(user.id, connection.id, { attended: false, client: bank.client });
    expect(result.imported).toBe(1);
    expect(result.notice).toContain("365 päivän");
    expect(await storedDays()).toEqual([daysAgo(300), daysAgo(30)]);
    const stored = await prisma.bankConnection.findUnique({ where: { id: connection.id } });
    expect(stored?.historyLimitDays).toBe(365);

    const next = fakeBank(ledger, { oldest: daysAgo(380) });
    await syncBankConnection(user.id, connection.id, { attended: false, client: next.client });
    expect(olderQueries(next.queries, daysAgo(10))).toHaveLength(0);

    const refused = await patch(connection.id, { historyFrom: daysAgo(500) });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("Pankki antaa tapahtumat enintään 12 kuukauden ajalta.");
  });
});

describe("closed months stay closed during a backfill", () => {
  it("reads only the open months, says so, and reads the rest once the month is reopened", async () => {
    const lockedMonth = daysAgo(100).slice(0, 7);
    const floor = firstDayOfNextMonth(daysAgo(100));
    const connection = await createConnection({ historyFrom: daysAgo(60) });
    const ledger = {
      "acc-1": [
        row("closed-1", daysAgo(140)),
        row("closed-2", daysAgo(100)),
        row("open-1", floor),
        row("recent", daysAgo(20)),
      ],
    };
    await syncBankConnection(user.id, connection.id, { attended: false, client: fakeBank(ledger).client });
    await prisma.user.update({ where: { id: user.id }, data: { booksLockedThrough: lockedMonth } });

    expect((await patch(connection.id, { historyFrom: daysAgo(150) })).status).toBe(200);
    const bank = fakeBank(ledger);
    const result = await syncBankConnection(user.id, connection.id, { attended: false, client: bank.client });
    const older = olderQueries(bank.queries, daysAgo(10));
    expect(older).toHaveLength(1);
    expect(older[0]).toMatchObject({ dateFrom: floor, dateTo: daysAgo(60) });
    expect(result.imported).toBe(1);
    expect(result.notice).toContain("lukittu");
    expect(await storedDays()).toEqual([floor, daysAgo(20)]);
    const stored = await prisma.bankConnection.findUnique({ where: { id: connection.id } });
    expect(stored?.lastSuccessAt?.getTime()).toBeGreaterThan(Date.now() - DAY_MS);

    await prisma.user.update({ where: { id: user.id }, data: { booksLockedThrough: null } });
    const reopened = fakeBank(ledger);
    const after = await syncBankConnection(user.id, connection.id, { attended: false, client: reopened.client });
    const olderAgain = olderQueries(reopened.queries, daysAgo(10));
    expect(olderAgain).toHaveLength(1);
    expect(olderAgain[0]).toMatchObject({ dateFrom: daysAgo(150), dateTo: floor });
    expect(after.imported).toBe(2);
    expect(await storedDays()).toEqual([daysAgo(140), daysAgo(100), floor, daysAgo(20)]);
  });
});

describe("PATCH /api/bank/connections/{id} keeps its other answers", () => {
  it("accounts alone still work and leave historyFrom alone", async () => {
    const connection = await createConnection({ historyFrom: daysAgo(60) });
    const account = connection.accounts[0];
    const changed = await patch(connection.id, { accounts: [{ id: account.id, inScope: false }] });
    expect(changed.status).toBe(200);
    expect(changed.body.connection.accounts[0].inScope).toBe(false);
    expect(changed.body.connection.historyFrom).toBe(daysAgo(60));
  });

  it("accounts and historyFrom together apply both; a refused day applies neither", async () => {
    const connection = await createConnection({ historyFrom: daysAgo(60) });
    const account = connection.accounts[0];
    const refused = await patch(connection.id, {
      accounts: [{ id: account.id, inScope: false }],
      historyFrom: "2999-01-01",
    });
    expect(refused.status).toBe(400);
    expect((await prisma.connectedAccount.findUnique({ where: { id: account.id } }))?.inScope).toBe(true);

    const both = await patch(connection.id, {
      accounts: [{ id: account.id, inScope: false }],
      historyFrom: daysAgo(90),
    });
    expect(both.status).toBe(200);
    expect(both.body.connection.accounts[0].inScope).toBe(false);
    expect(both.body.connection.historyFrom).toBe(daysAgo(90));
  });

  it("an empty body is a 400", async () => {
    const connection = await createConnection();
    expect((await patch(connection.id, {})).status).toBe(400);
  });

  it("another owner's connection is a 404 and stays unchanged", async () => {
    const other = await createUser();
    const theirs = await createConnection({ userId: other.id, historyFrom: daysAgo(60) });
    const answered = await patch(theirs.id, { historyFrom: daysAgo(90) });
    expect(answered.status).toBe(404);
    const stored = await prisma.bankConnection.findUnique({ where: { id: theirs.id } });
    expect(stored?.historyFrom).toBe(daysAgo(60));
  });

  it("the public connection carries historyFrom and historyLimitDays", async () => {
    await createConnection({ historyFrom: daysAgo(60) });
    const response = await listConnections(buildRequest("GET", "/api/bank/connections", undefined, { cookie }));
    const body = await readJson(response);
    expect(body.connections[0]).toMatchObject({ historyFrom: daysAgo(60), historyLimitDays: null });
  });
});

describe("audit 2026-10-09: an account's own history, whatever the connection's last sync", () => {
  it("an account put in scope after the first sync of an all-history connection gets its history", async () => {
    const connection = await createConnection({
      historyFrom: null,
      accounts: [
        { iban: IBAN_A, uid: "acc-1", inScope: true },
        { iban: IBAN_B, uid: "acc-2", inScope: false },
      ],
    });
    const ledger = {
      "acc-1": [row("a1", daysAgo(40)), row("a2", daysAgo(2))],
      "acc-2": [row("b1", daysAgo(80)), row("b2", daysAgo(30)), row("b3", daysAgo(1))],
    };
    await syncBankConnection(user.id, connection.id, { attended: true, client: fakeBank(ledger).client });
    await prisma.connectedAccount.updateMany({ where: { connectionId: connection.id, iban: IBAN_B }, data: { inScope: true } });
    await syncBankConnection(user.id, connection.id, { attended: true, client: fakeBank(ledger).client });
    const b = await prisma.transaction.findMany({ where: { userId: user.id, iban: IBAN_B }, select: { bankRef: true } });
    expect(b.length).toBe(3);
  });

  it("an account back in scope after a pause gets the rows of the pause", async () => {
    const connection = await createConnection({ historyFrom: daysAgo(90) });
    const ledger = { "acc-1": [row("a1", daysAgo(60)), row("a2", daysAgo(45)), row("a3", daysAgo(20)), row("a4", daysAgo(1))] };
    // Synced long ago (rows up to 50 days back), out of scope since, the connection synced yesterday.
    await syncBankConnection(user.id, connection.id, { attended: true, client: fakeBank({ "acc-1": ledger["acc-1"].slice(0, 1) }).client });
    // Its balance was fetched with that pull, 50 days ago; the connection itself synced yesterday.
    await prisma.connectedAccount.updateMany({ where: { connectionId: connection.id }, data: { balanceAt: new Date(Date.now() - 50 * DAY_MS) } });
    await prisma.bankConnection.update({ where: { id: connection.id }, data: { lastSuccessAt: new Date(Date.now() - DAY_MS) } });
    await syncBankConnection(user.id, connection.id, { attended: true, client: fakeBank(ledger).client });
    expect(await storedDays()).toEqual([daysAgo(60), daysAgo(45), daysAgo(20), daysAgo(1)].sort());
  });
});
