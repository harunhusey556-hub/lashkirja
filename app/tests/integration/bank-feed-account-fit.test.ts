/**
 * 2026-10-09 audit: an account made in the app opens today with a balance of 0. Rows the bank
 * connection brings from before today fell outside its balance, so Koti and Pankki showed only
 * today's movement (the bank-feed side of 1c8fab2, which fixed file uploads).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/encryption";
import { createBankAccount, getAccountRollforward } from "@/lib/bank-accounts";
import type { EnableBankingClient } from "@/lib/enablebanking/client";
import type { EbTransaction } from "@/lib/enablebanking/mapping";
import { syncBankConnection } from "@/lib/enablebanking/sync";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";

const IBAN = "FI2112345600000785";
let user: TestUser;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
});

const today = new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

function row(date: string, amount: string, credit: boolean, ref: string): EbTransaction {
  return {
    status: "BOOK",
    booking_date: date,
    entry_reference: ref,
    credit_debit_indicator: credit ? "CRDT" : "DBIT",
    transaction_amount: { currency: "EUR", amount },
    ...(credit ? { debtor: { name: "Asiakas Oy" } } : { creditor: { name: "Kauppa Oy" } }),
  } as EbTransaction;
}

async function connection() {
  return prisma.bankConnection.create({
    data: {
      userId: user.id, aspspName: "Holvi", aspspCountry: "FI", psuType: "business", status: "active",
      sessionIdEnc: encrypt("session-1"), validUntil: new Date("2099-01-01T00:00:00.000Z"),
      accounts: { create: [{ userId: user.id, iban: IBAN, label: "Päätili", providerAccountUid: "acc-1", inScope: true }] },
    },
  });
}

function bank(balance: string): EnableBankingClient {
  return {
    getSession: async () => ({ status: "AUTHORIZED" }),
    getAccountBalances: async () => [{ balance_type: "CLBD", balance_amount: { amount: balance, currency: "EUR" } }],
    getAccountTransactions: async () => ({
      transactions: [row(daysAgo(50), "5000.00", true, "r1"), row(daysAgo(20), "1200.00", false, "r2"), row(today, "5.00", false, "r3")],
      continuationKey: null,
    }),
  } as unknown as EnableBankingClient;
}

describe("an account opened today in the app, fed by the bank connection", () => {
  it("the first sync moves it back to its first row and its balance is the bank's", async () => {
    const account = await createBankAccount(user.id, { name: "Päätili", iban: IBAN, openingBalance: 0, openingDate: today });
    const made = await connection();
    await syncBankConnection(user.id, made.id, { attended: true, client: bank("4000.00") });
    const stored = await prisma.bankAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect(stored.openingDate.toISOString().slice(0, 10)).toBe(daysAgo(50));
    expect(stored.openingBalanceCents).toBe(400_000 - 379_500);
    expect((await getAccountRollforward(user.id, account.id)).currentBalance).toBe(4000);
  });

  it("an account created after the bank was connected fits the rows it adopts", async () => {
    const made = await connection();
    await syncBankConnection(user.id, made.id, { attended: true, client: bank("4000.00") });
    const account = await createBankAccount(user.id, { name: "Päätili", iban: IBAN, openingBalance: 0, openingDate: today });
    expect((await getAccountRollforward(user.id, account.id)).currentBalance).toBe(4000);
  });

  it("an opening balance the owner entered is never changed", async () => {
    const account = await createBankAccount(user.id, { name: "Päätili", iban: IBAN, openingBalance: 150, openingDate: today });
    const made = await connection();
    await syncBankConnection(user.id, made.id, { attended: true, client: bank("4000.00") });
    const stored = await prisma.bankAccount.findUniqueOrThrow({ where: { id: account.id } });
    expect([stored.openingBalanceCents, stored.openingDate.toISOString().slice(0, 10)]).toEqual([15_000, today]);
  });
});

describe("default account after the only one was archived (audit A#5)", () => {
  it("the next account created is the default again", async () => {
    const first = await createBankAccount(user.id, { name: "Vanha", iban: null, openingBalance: 0, openingDate: today });
    await prisma.bankAccount.update({ where: { id: first.id }, data: { archivedAt: new Date(), isDefault: false } });
    const next = await createBankAccount(user.id, { name: "Uusi", iban: null, openingBalance: 0, openingDate: today });
    expect(next.isDefault).toBe(true);
  });
});
