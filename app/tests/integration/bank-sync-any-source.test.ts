import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/encryption";
import type { EnableBankingClient, TransactionQuery } from "@/lib/enablebanking/client";
import type { EbTransaction } from "@/lib/enablebanking/mapping";
import { syncBankConnection } from "@/lib/enablebanking/sync";
import { POST as uploadStatement } from "@/app/api/statements/route";
import { createBankAccountRow, createStatementWithTransactions, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildFormRequest, readJson, sessionCookie } from "./helpers/http";

const IBAN = "FI2112345600000785";
let user: TestUser;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
});

async function createConnection() {
  return prisma.bankConnection.create({
    data: {
      userId: user.id,
      aspspName: "Testipankki",
      aspspCountry: "FI",
      psuType: "business",
      status: "active",
      sessionIdEnc: encrypt("session-1"),
      validUntil: new Date("2099-01-01T00:00:00.000Z"),
      accounts: {
        create: [{ userId: user.id, iban: IBAN, label: "Käyttötili", providerAccountUid: "acc-1", inScope: true }],
      },
    },
  });
}

function client(rows: EbTransaction[]) {
  return {
    getSession: async () => ({ status: "AUTHORIZED" }),
    getAccountBalances: async () => [],
    getAccountTransactions: async (_query: TransactionQuery) => ({ transactions: rows, continuationKey: null }),
  } as unknown as EnableBankingClient;
}

const run = (rows: EbTransaction[], id: string) =>
  syncBankConnection(user.id, id, { attended: false, client: client(rows) });
const stored = () =>
  prisma.transaction.findMany({ where: { userId: user.id }, orderBy: [{ date: "asc" }, { bankRef: "asc" }] });
const storedAll = () =>
  prisma.transaction.findMany({ where: { statement: { userId: user.id } }, orderBy: [{ date: "asc" }, { amountCents: "asc" }] });

function feedRow(date: string, amount: string, name: string, extra: Partial<EbTransaction> = {}): EbTransaction {
  return {
    status: "BOOK",
    booking_date: date,
    credit_debit_indicator: "DBIT",
    transaction_amount: { currency: "EUR", amount },
    creditor: { name },
    ...extra,
  };
}

describe("V25 R52: a feed connected after file imports does not store the overlap twice", () => {
  it("skips the movements a file for the same account already holds, adopts them, and imports only the new one", async () => {
    const account = await createBankAccountRow(user.id, { iban: IBAN });
    const file = await createStatementWithTransactions(user.id, {
      bankAccountId: account.id,
      periodMonth: "2026-09",
      transactions: [
        { date: "2026-09-01", amountCents: -3590, counterparty: "K-Market Kamppi" },
        { date: "2026-09-15", amountCents: -1250, counterparty: "Spotify" },
      ],
    });
    const connection = await createConnection();
    const rows = [
      feedRow("2026-09-01", "35.90", "K-MARKET KAMPPI", { entry_reference: "E1" }),
      feedRow("2026-09-15", "12.50", "SPOTIFY", { entry_reference: "E2" }),
      feedRow("2026-09-20", "8.00", "Kioski", { entry_reference: "E3" }),
    ];
    const first = await run(rows, connection.id);
    expect(first.imported).toBe(1);
    expect(first.skipped).toBe(2);
    expect(await storedAll()).toHaveLength(3);
    // The file rows took over the bank's keys, so the next delivery is recognised by key.
    const adopted = await prisma.transaction.findMany({ where: { statementId: file.id }, orderBy: { date: "asc" } });
    expect(adopted.map((tx) => tx.bankRef)).toEqual([`eb:${IBAN}:E1`, `eb:${IBAN}:E2`]);
    const again = await run(rows, connection.id);
    expect(again.imported).toBe(0);
    expect(await storedAll()).toHaveLength(3);
  });

  it("keeps a genuine second movement when the file holds only one", async () => {
    const account = await createBankAccountRow(user.id, { iban: IBAN });
    await createStatementWithTransactions(user.id, {
      bankAccountId: account.id,
      periodMonth: "2026-09",
      transactions: [{ date: "2026-09-01", amountCents: -450, counterparty: "Kahvila" }],
    });
    const connection = await createConnection();
    const result = await run(
      [
        feedRow("2026-09-01", "4.50", "Kahvila", { entry_reference: "A" }),
        feedRow("2026-09-01", "4.50", "Kahvila", { entry_reference: "B" }),
      ],
      connection.id
    );
    expect(result.imported).toBe(1);
    expect(await storedAll()).toHaveLength(2);
  });
});

describe("V32: one movement stays one row when the bank changes its identifiers", () => {
  const sale = (extra: Partial<EbTransaction>) =>
    feedRow("2026-09-30", "80.00", "MobilePay", {
      credit_debit_indicator: "CRDT",
      debtor: { name: "MobilePay" },
      creditor: undefined,
      remittance_information: ["Myyntitilitys"],
      ...extra,
    });

  it("entry_reference dropped, transaction_id kept", async () => {
    const connection = await createConnection();
    await run([sale({ entry_reference: "kE004", transaction_id: "TX-9001" })], connection.id);
    const second = await run([sale({ transaction_id: "TX-9001" })], connection.id);
    expect(second.imported).toBe(0);
    expect(await stored()).toHaveLength(1);
    expect(await prisma.receipt.count({ where: { userId: user.id, source: "auto_income" } })).toBe(1);
  });

  it("transaction_id that changes between fetches", async () => {
    const connection = await createConnection();
    await run([sale({ transaction_id: "T1" })], connection.id);
    const second = await run([sale({ transaction_id: "T2" })], connection.id);
    expect(second.imported).toBe(0);
    expect(await stored()).toHaveLength(1);
    expect(await prisma.receipt.count({ where: { userId: user.id, source: "auto_income" } })).toBe(1);
  });

  it("a reference_number that disappears from a row without any id", async () => {
    const connection = await createConnection();
    const withRef = feedRow("2026-09-30", "10.00", "Juusto", { reference_number: "RF1234" });
    await run([withRef], connection.id);
    const { reference_number: _dropped, ...without } = withRef;
    void _dropped;
    const second = await run([without], connection.id);
    expect(second.imported).toBe(0);
    expect(await stored()).toHaveLength(1);
  });

  it("two genuine movements with different ids are still two", async () => {
    const connection = await createConnection();
    const result = await run(
      [sale({ entry_reference: "A", transaction_id: "T-A" }), sale({ entry_reference: "B", transaction_id: "T-B" })],
      connection.id
    );
    expect(result.imported).toBe(2);
    const again = await run(
      [sale({ transaction_id: "T-A" }), sale({ transaction_id: "T-B" })],
      connection.id
    );
    expect(again.imported).toBe(0);
    expect(await stored()).toHaveLength(2);
  });
});

describe("V27: a file import compares with feed rows whose statement has no linked account", () => {
  it("skips rows the feed already holds for the file's IBAN", async () => {
    const connection = await createConnection();
    await run(
      [
        feedRow("2026-09-01", "35.90", "K-Market Kamppi", { entry_reference: "E1" }),
        feedRow("2026-09-15", "12.50", "Spotify", { entry_reference: "E2" }),
      ],
      connection.id
    );
    const statement = await prisma.statement.findFirstOrThrow({ where: { userId: user.id } });
    expect(statement.bankAccountId).toBeNull();

    const other = await createBankAccountRow(user.id, { name: "Oletus", iban: null, isDefault: true });
    void other;
    const cookie = await sessionCookie(user);
    const csv =
      "Kirjauspäivä;Summa;Saaja\n01.09.2026;-35,90;K-Market Kamppi\n15.09.2026;-12,50;Spotify\n20.09.2026;-8,00;Kioski\n";
    const form = new FormData();
    form.set("file", new File([`IBAN ${IBAN}\n${csv}`], "tiliote.csv", { type: "text/csv" }));
    const response = await uploadStatement(buildFormRequest("/api/statements", form, { cookie }));
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.count).toBe(1);
    expect(body.skippedDuplicates).toBe(2);
    expect(await storedAll()).toHaveLength(3);
  });
});
