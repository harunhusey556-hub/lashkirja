import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/encryption";
import {
  EnableBankingError,
  MAX_TRANSACTION_PAGES,
  type EnableBankingClient,
  type TransactionQuery,
} from "@/lib/enablebanking/client";
import type { EbTransaction } from "@/lib/enablebanking/mapping";
import { syncBankConnection } from "@/lib/enablebanking/sync";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";

const IBAN = "FI2112345600000785";
let user: TestUser;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
});

async function createConnection(extra: { lastSuccessAt?: Date } = {}) {
  return prisma.bankConnection.create({
    data: {
      userId: user.id,
      aspspName: "Testipankki",
      aspspCountry: "FI",
      psuType: "business",
      status: "active",
      sessionIdEnc: encrypt("session-1"),
      validUntil: new Date("2099-01-01T00:00:00.000Z"),
      lastSuccessAt: extra.lastSuccessAt ?? null,
      accounts: {
        create: [{ userId: user.id, iban: IBAN, label: "Käyttötili", providerAccountUid: "acc-1", inScope: true }],
      },
    },
  });
}

type Page = { transactions: EbTransaction[]; continuationKey: string | null };

/** The bank as a list of pages, walked by continuation key. */
function fakeClient(pages: Array<Page | Error> | ((query: TransactionQuery) => Page | Error)) {
  const queries: TransactionQuery[] = [];
  const client = {
    getSession: async () => ({ status: "AUTHORIZED" }),
    getAccountBalances: async () => [],
    getAccountTransactions: async (query: TransactionQuery) => {
      queries.push(query);
      const answer =
        typeof pages === "function" ? pages(query) : pages[query.continuationKey ? Number(query.continuationKey) : 0];
      if (answer instanceof Error) throw answer;
      return answer;
    },
  } as unknown as EnableBankingClient;
  return { client, queries };
}

function row(id: string, date: string, amount: string, extra: Partial<EbTransaction> = {}): EbTransaction {
  return {
    status: "BOOK",
    entry_reference: id,
    booking_date: date,
    credit_debit_indicator: "DBIT",
    transaction_amount: { currency: "EUR", amount },
    creditor: { name: "Kauppa Oy" },
    ...extra,
  };
}

describe("a pull that is not complete never counts as a finished sync", () => {
  it("G27: a bank that pages past the ceiling is written, flagged, and not marked as caught up", async () => {
    const connection = await createConnection();
    const { client } = fakeClient((query) => {
      const page = query.continuationKey ? Number(query.continuationKey) : 0;
      return {
        transactions: [row(`r${page}`, "2026-08-10", "1.00")],
        continuationKey: String(page + 1),
      };
    });
    const result = await syncBankConnection(user.id, connection.id, { attended: false, client });
    expect(result.partial).toBe(true);
    expect(result.imported).toBe(MAX_TRANSACTION_PAGES);
    expect(result.accounts[0].partial).toBe(true);
    const stored = await prisma.bankConnection.findUnique({ where: { id: connection.id } });
    expect(stored?.lastSuccessAt).toBeNull();
    expect(stored?.lastError).toBe(result.notice);
    expect(stored?.lastError).toContain("seuraavalla kerralla");
  });

  it("G27: a truncated incremental sync keeps the old lastSuccessAt", async () => {
    const before = new Date("2026-09-01T10:00:00.000Z");
    const connection = await createConnection({ lastSuccessAt: before });
    const { client } = fakeClient(() => ({ transactions: [row("same", "2026-08-10", "1.00")], continuationKey: "loop" }));
    const result = await syncBankConnection(user.id, connection.id, { attended: false, client });
    expect(result.partial).toBe(true);
    const stored = await prisma.bankConnection.findUnique({ where: { id: connection.id } });
    expect(stored?.lastSuccessAt?.toISOString()).toBe(before.toISOString());
  });

  it("G27: a complete long pull (250 pages) imports everything and clears the notice", async () => {
    const connection = await createConnection();
    const { client } = fakeClient((query) => {
      const page = query.continuationKey ? Number(query.continuationKey) : 0;
      return {
        transactions: [row(`r${page}`, "2026-08-10", "1.00")],
        continuationKey: page + 1 < 250 ? String(page + 1) : null,
      };
    });
    const result = await syncBankConnection(user.id, connection.id, { attended: false, client });
    expect(result.partial).toBe(false);
    expect(result.imported).toBe(250);
    const stored = await prisma.bankConnection.findUnique({ where: { id: connection.id } });
    expect(stored?.lastSuccessAt).not.toBeNull();
    expect(stored?.lastError).toBeNull();
  });

  it("G28: a broken page fails the sync, leaves lastSuccessAt alone, and the retry reads everything", async () => {
    const connection = await createConnection();
    const broken = new EnableBankingError("Pankin vastausta ei voitu lukea.", 502, "INVALID_RESPONSE");
    const first = fakeClient([
      { transactions: [row("a", "2026-07-01", "5.00")], continuationKey: "1" },
      broken,
    ]);
    await expect(
      syncBankConnection(user.id, connection.id, { attended: false, client: first.client })
    ).rejects.toMatchObject({ status: 502 });
    let stored = await prisma.bankConnection.findUnique({ where: { id: connection.id } });
    expect(stored?.lastSuccessAt).toBeNull();
    expect(stored?.lastError).toBe("Pankin vastausta ei voitu lukea. Yritä uudelleen.");

    const second = fakeClient([
      { transactions: [row("a", "2026-07-01", "5.00")], continuationKey: "1" },
      { transactions: [row("b", "2026-06-01", "6.00")], continuationKey: null },
    ]);
    const result = await syncBankConnection(user.id, connection.id, { attended: false, client: second.client });
    expect(result.imported).toBe(2);
    expect(second.queries[0].strategy).toBe("longest");
    stored = await prisma.bankConnection.findUnique({ where: { id: connection.id } });
    expect(stored?.lastSuccessAt).not.toBeNull();
  });
});

const T = (ibanRow: EbTransaction[]) => fakeClient([{ transactions: ibanRow, continuationKey: null }]).client;
const run = (rows: EbTransaction[], id: string) => syncBankConnection(user.id, id, { attended: false, client: T(rows) });
const stored = () =>
  prisma.transaction.findMany({ where: { userId: user.id }, orderBy: [{ date: "asc" }, { bankRef: "asc" }] });

function bare(date: string, amount: string, extra: Partial<EbTransaction> = {}): EbTransaction {
  return {
    status: "BOOK",
    booking_date: date,
    credit_debit_indicator: "DBIT",
    transaction_amount: { currency: "EUR", amount },
    creditor: { name: "R-kioski" },
    remittance_information: ["Kahvi  ostos"],
    ...extra,
  };
}

describe("one bank movement is one row (G26)", () => {
  it("a re-delivery with '7.50', stray whitespace or case adds nothing", async () => {
    const connection = await createConnection();
    expect((await run([bare("2026-09-29", "7.5")], connection.id)).imported).toBe(1);
    const again = await run(
      [bare("2026-09-29", "7.50", { remittance_information: ["kahvi ostos "], creditor: { name: " R-KIOSKI" } })],
      connection.id
    );
    expect(again.imported).toBe(0);
    expect(again.skipped).toBe(1);
    expect(await stored()).toHaveLength(1);
  });

  it("a bank that drops entry_reference later does not double the row", async () => {
    const connection = await createConnection();
    const withRef = bare("2026-09-30", "80.00", { entry_reference: "E004", credit_debit_indicator: "CRDT" });
    const { entry_reference: _dropped, ...withoutRef } = withRef;
    void _dropped;
    await run([withRef], connection.id);
    const second = await run([withoutRef], connection.id);
    expect(second.imported).toBe(0);
    const third = await run([withRef], connection.id);
    expect(third.imported).toBe(0);
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0].bankRef).toBe(`eb:${IBAN}:E004`);
  });

  it("a reference that appears later adopts the row stored without one", async () => {
    const connection = await createConnection();
    await run([bare("2026-09-30", "4.00")], connection.id);
    const second = await run([bare("2026-09-30", "4.00", { entry_reference: "LATE-1" })], connection.id);
    expect(second.imported).toBe(0);
    const rows = await stored();
    expect(rows).toHaveLength(1);
    expect(rows[0].bankRef).toBe(`eb:${IBAN}:LATE-1`);
  });

  it("recognises a row stored under the old raw-string key", async () => {
    const connection = await createConnection();
    const statement = await prisma.statement.create({
      data: {
        userId: user.id,
        fileName: "eb",
        fileType: "enablebanking",
        filePath: "enablebanking",
        checksum: `eb:${IBAN}:2026-09`,
        periodMonth: "2026-09",
      },
    });
    // What the pre-fix sync stored for bare("2026-09-29", "7.5"): sha256 of the raw strings.
    const { createHash } = await import("crypto");
    const digest = createHash("sha256")
      .update([IBAN, "2026-09-29", "", "7.5", "DBIT", "", "Kahvi  ostos", "R-kioski", ""].join("\n"), "utf8")
      .digest("hex")
      .slice(0, 32);
    await prisma.transaction.create({
      data: {
        statementId: statement.id,
        userId: user.id,
        date: new Date("2026-09-29T00:00:00.000Z"),
        counterparty: "R-kioski",
        amountCents: -750,
        message: "Kahvi  ostos",
        type: "meno",
        bankRef: `eb:${IBAN}:${digest}`,
        source: "enablebanking",
        iban: IBAN,
      },
    });
    const result = await run([bare("2026-09-29", "7.5")], connection.id);
    expect(result.imported).toBe(0);
    expect(result.skipped).toBe(1);
    expect(await stored()).toHaveLength(1);
  });

  it("keeps two different movements that only look alike when their references differ", async () => {
    const connection = await createConnection();
    const result = await run(
      [bare("2026-09-29", "3.50", { entry_reference: "A" }), bare("2026-09-29", "3.50", { entry_reference: "B" })],
      connection.id
    );
    expect(result.imported).toBe(2);
  });
});

describe("two genuine identical rows without a reference are both kept (G29)", () => {
  it("stores twins from one delivery and stays stable on re-sync", async () => {
    const connection = await createConnection();
    const twin = () => bare("2026-09-30", "3.50");
    const first = await run([twin(), twin()], connection.id);
    expect(first.imported).toBe(2);
    expect((await stored()).reduce((sum, row) => sum + row.amountCents, 0)).toBe(-700);
    const again = await run([twin(), twin()], connection.id);
    expect(again.imported).toBe(0);
    expect(await stored()).toHaveLength(2);
  });

  it("imports only the new twin when the feed grows from one to two", async () => {
    const connection = await createConnection();
    await run([bare("2026-09-30", "3.50")], connection.id);
    const next = await run([bare("2026-09-30", "3.50"), bare("2026-09-30", "3.50")], connection.id);
    expect(next.imported).toBe(1);
    expect(await stored()).toHaveLength(2);
  });

  it("still treats a repeated bank reference as one movement", async () => {
    const connection = await createConnection();
    const row = bare("2026-09-30", "3.50", { entry_reference: "SAME" });
    const result = await run([row, row], connection.id);
    expect(result.imported).toBe(1);
  });
});

describe("bank sync honours the period lock (G25)", () => {
  const lockThrough = (month: string | null) =>
    prisma.user.update({ where: { id: user.id }, data: { booksLockedThrough: month } });
  const income = (id: string, date: string, amount: string) =>
    row(id, date, amount, { credit_debit_indicator: "CRDT", debtor: { name: "Asiakas Kaksi" }, creditor: undefined });

  it("writes nothing into a closed month, drafts no sale for it, and says so", async () => {
    const before = new Date("2026-09-20T10:00:00.000Z");
    const connection = await createConnection({ lastSuccessAt: before });
    await lockThrough("2026-09");
    const result = await run(
      [income("S1", "2026-09-29", "55.00"), row("S2", "2026-09-29", "18.00"), income("O1", "2026-10-01", "10.00")],
      connection.id
    );
    expect(result.imported).toBe(1);
    expect(result.heldBack).toBe(2);
    expect(result.partial).toBe(true);
    expect(result.notice).toBe("Kuukausi on lukittu, 2 tapahtumaa jäi tuomatta.");
    expect(result.accounts[0].heldBack).toBe(2);

    const rows = await stored();
    expect(rows.map((tx) => tx.bankRef)).toEqual([`eb:${IBAN}:O1`]);
    const statements = await prisma.statement.findMany({ where: { userId: user.id } });
    expect(statements.map((statement) => statement.periodMonth)).toEqual(["2026-10"]);
    const drafts = await prisma.receipt.findMany({ where: { userId: user.id } });
    expect(drafts.every((receipt) => receipt.date && receipt.date.toISOString() >= "2026-10-01")).toBe(true);

    const connectionRow = await prisma.bankConnection.findUnique({ where: { id: connection.id } });
    expect(connectionRow?.lastSuccessAt?.toISOString()).toBe(before.toISOString());
    expect(connectionRow?.lastError).toBe("Kuukausi on lukittu, 2 tapahtumaa jäi tuomatta.");
  });

  it("uses the singular for one held row", async () => {
    const connection = await createConnection();
    await lockThrough("2026-09");
    const result = await run([income("S1", "2026-09-29", "55.00")], connection.id);
    expect(result.notice).toBe("Kuukausi on lukittu, 1 tapahtuma jäi tuomatta.");
  });

  it("brings the held rows in on the next sync once the month is reopened", async () => {
    const connection = await createConnection();
    await lockThrough("2026-09");
    const rows = [income("S1", "2026-09-29", "55.00"), income("O1", "2026-10-01", "10.00")];
    await run(rows, connection.id);
    expect(await stored()).toHaveLength(1);

    await lockThrough(null);
    const after = await run(rows, connection.id);
    expect(after.imported).toBe(1);
    expect(after.heldBack).toBe(0);
    expect(after.partial).toBe(false);
    expect(await stored()).toHaveLength(2);
    const connectionRow = await prisma.bankConnection.findUnique({ where: { id: connection.id } });
    expect(connectionRow?.lastError).toBeNull();
    expect(connectionRow?.lastSuccessAt).not.toBeNull();
  });

  it("holds back a first sync whose whole history lies in closed months", async () => {
    const connection = await createConnection();
    await lockThrough("2026-09");
    const result = await run([row("A", "2026-03-01", "5.00"), row("B", "2026-08-01", "6.00")], connection.id);
    expect(result.imported).toBe(0);
    expect(result.heldBack).toBe(2);
    expect(await prisma.statement.count({ where: { userId: user.id } })).toBe(0);
    const connectionRow = await prisma.bankConnection.findUnique({ where: { id: connection.id } });
    expect(connectionRow?.lastSuccessAt).toBeNull();
  });
});
