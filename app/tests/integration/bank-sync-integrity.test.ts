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
