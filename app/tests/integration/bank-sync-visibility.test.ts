import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/encryption";
import { EnableBankingError, type EnableBankingClient, type TransactionQuery } from "@/lib/enablebanking/client";
import type { EbTransaction } from "@/lib/enablebanking/mapping";
import { syncBankConnection } from "@/lib/enablebanking/sync";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";

const IBAN = "FI2112345600000785";
let user: TestUser;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
});

async function createConnection(extra: { historyFrom?: string; lastSuccessAt?: Date; lastError?: string } = {}) {
  return prisma.bankConnection.create({
    data: {
      userId: user.id,
      aspspName: "Testipankki",
      aspspCountry: "FI",
      psuType: "business",
      status: "active",
      sessionIdEnc: encrypt("session-1"),
      validUntil: new Date("2099-01-01T00:00:00.000Z"),
      historyFrom: extra.historyFrom ?? null,
      lastSuccessAt: extra.lastSuccessAt ?? null,
      lastError: extra.lastError ?? null,
      accounts: {
        create: [{ userId: user.id, iban: IBAN, label: "Käyttötili", providerAccountUid: "acc-1", inScope: true }],
      },
    },
  });
}

function bank(rows: EbTransaction[], limit?: (query: TransactionQuery) => boolean) {
  const queries: TransactionQuery[] = [];
  const client = {
    getSession: async () => ({ status: "AUTHORIZED" }),
    getAccountBalances: async () => [],
    getAccountTransactions: async (query: TransactionQuery) => {
      queries.push(query);
      if (limit && !limit(query)) throw new EnableBankingError("period", 422, "WRONG_TRANSACTIONS_PERIOD");
      return { transactions: rows, continuationKey: null };
    },
  } as unknown as EnableBankingClient;
  return { client, queries };
}

function row(id: string, date: string, amount: string): EbTransaction {
  return {
    status: "BOOK",
    entry_reference: id,
    booking_date: date,
    credit_debit_indicator: "DBIT",
    transaction_amount: { currency: "EUR", amount },
    creditor: { name: "Kauppa Oy" },
  };
}

const lockThrough = (month: string | null) =>
  prisma.user.update({ where: { id: user.id }, data: { booksLockedThrough: month } });

describe("R65: held rows never wedge the connection", () => {
  it("a first sync held back entirely leaves an ordinary incremental connection that reads back to the held rows", async () => {
    const connection = await createConnection();
    await lockThrough("2026-09");
    const rows = [row("A", "2026-03-01", "5.00"), row("B", "2026-08-01", "6.00")];
    const first = bank(rows);
    const result = await syncBankConnection(user.id, connection.id, { attended: false, client: first.client });
    expect(result.imported).toBe(0);
    expect(result.heldBack).toBe(2);
    expect(first.queries[0].strategy).toBe("longest");

    const stored = await prisma.bankConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(stored.status).toBe("active");
    expect(stored.lastSuccessAt).not.toBeNull();

    // The next sync is a dated incremental pull, not the open-ended first one.
    const second = bank(rows);
    await syncBankConnection(user.id, connection.id, { attended: false, client: second.client });
    expect(second.queries[0].strategy).toBeUndefined();
    expect(second.queries[0].dateFrom! <= "2026-03-01").toBe(true);

    // The held rows arrive once the month is reopened, and the note goes away.
    await lockThrough(null);
    const third = bank(rows);
    const reopened = await syncBankConnection(user.id, connection.id, { attended: false, client: third.client });
    expect(reopened.imported).toBe(2);
    expect(reopened.notice).toBeNull();
    const after = await prisma.bankConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(after.lastError).toBeNull();
    expect(await prisma.transaction.count({ where: { userId: user.id } })).toBe(2);
  });
});

describe("R55: a first sync whose window the bank shortened says so and does not look caught up", () => {
  it("names the days, keeps the sentence, and keeps it on the next clean sync", async () => {
    const connection = await createConnection({ historyFrom: "2025-01-01" });
    // The bank serves only the last 30 days.
    const cutoff = new Date(Date.now() - 31 * 86_400_000).toISOString().slice(0, 10);
    const recent = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
    const first = bank([row("R1", recent, "4.00")], (query) => !query.dateFrom || query.dateFrom >= cutoff);
    const result = await syncBankConnection(user.id, connection.id, { attended: false, client: first.client });
    expect(result.partial).toBe(true);
    expect(result.notice).toMatch(
      /^Pankki antoi tapahtumat vain viimeisen \d+ päivän ajalta, vanhemmat voit tuoda tiliotteena\.$/
    );
    const stored = await prisma.bankConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(stored.lastError).toBe(result.notice);

    const second = bank([row("R1", recent, "4.00")]);
    const next = await syncBankConnection(user.id, connection.id, { attended: false, client: second.client });
    expect(next.notice).toBeNull();
    const after = await prisma.bankConnection.findUniqueOrThrow({ where: { id: connection.id } });
    expect(after.lastError).toBe(result.notice);
  });

  it("a first sync that was served in full carries no note", async () => {
    const connection = await createConnection({ historyFrom: "2026-01-01" });
    const result = await syncBankConnection(user.id, connection.id, {
      attended: false,
      client: bank([row("R1", "2026-09-01", "4.00")]).client,
    });
    expect(result.partial).toBe(false);
    expect(result.notice).toBeNull();
  });
});
