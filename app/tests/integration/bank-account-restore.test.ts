/**
 * Live-use test 2026-09-30 (F51 F52 G30): an archived bank account is not a
 * dead end and never receives a tiliote by guesswork, and a bank account
 * created after a bank sync claims the statements of its own IBAN.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { prisma } from "@/lib/db";
import { encrypt } from "@/lib/encryption";
import { POST as uploadStatement } from "@/app/api/statements/route";
import { POST as createAccount } from "@/app/api/bank-accounts/route";
import { PATCH as patchAccount } from "@/app/api/bank-accounts/[id]/route";
import { createBankAccount, getBankOverview, resolveAccountForImport, updateBankAccount } from "@/lib/bank-accounts";
import type { EnableBankingClient } from "@/lib/enablebanking/client";
import { syncBankConnection } from "@/lib/enablebanking/sync";
import { createBankAccountRow, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildFormRequest, buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

const IBAN_A = "FI2112345600000785"; // Nordea
const IBAN_B = "FI4950009420028730"; // OP
let user: TestUser;
let cookie: string;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

afterAll(() => {
  fs.rmSync(path.join(process.cwd(), "data", "uploads"), { recursive: true, force: true });
});

async function archive(id: string) {
  await prisma.bankAccount.update({ where: { id }, data: { archivedAt: new Date(), isDefault: false } });
}

function upload(body: string) {
  const form = new FormData();
  form.set("file", new File([body], "tiliote.csv", { type: "text/csv" }));
  return uploadStatement(buildFormRequest("/api/statements", form, { cookie }));
}

describe("F51: an archived account can come back", () => {
  it("adding its IBAN again restores the account and says so", async () => {
    const old = await createBankAccountRow(user.id, { name: "Käyttötili", iban: IBAN_A, openingBalanceCents: 100_000 });
    await archive(old.id);

    const response = await createAccount(
      buildRequest(
        "POST",
        "/api/bank-accounts",
        { name: "Uusi nimi", iban: "FI21 1234 5600 0007 85", openingBalance: 5, openingDate: "2026-03-01" },
        { cookie }
      )
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.restored).toBe(true);
    expect(body.account.id).toBe(old.id);
    expect(body.account.archivedAt).toBeNull();
    // The history already counted against the account keeps its opening balance.
    expect(body.account.openingBalance).toBe(1000);
    expect(await prisma.bankAccount.count({ where: { userId: user.id } })).toBe(1);
  });

  it("the restore through PATCH archived:false works", async () => {
    const old = await createBankAccountRow(user.id, { name: "Käyttötili", iban: IBAN_A });
    await archive(old.id);
    const response = await patchAccount(
      buildRequest("PATCH", `/api/bank-accounts/${old.id}`, { archived: false }, { cookie }),
      routeContext({ id: old.id })
    );
    expect(response.status).toBe(200);
    expect((await prisma.bankAccount.findUniqueOrThrow({ where: { id: old.id } })).archivedAt).toBeNull();
  });

  it("changing another account's IBAN to an archived one names the archived account", async () => {
    const old = await createBankAccountRow(user.id, { name: "Vanha tili", iban: IBAN_A });
    await archive(old.id);
    const other = await createBankAccountRow(user.id, { name: "Toinen", iban: IBAN_B });
    const error = await updateBankAccount(user.id, other.id, { iban: IBAN_A }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "IBAN_ARCHIVED", statusCode: 409 });
    expect((error as Error).message).toContain("Vanha tili");
  });

  it("an active holder still refuses a second account with the same IBAN", async () => {
    await createBankAccountRow(user.id, { name: "Aktiivinen", iban: IBAN_A });
    const error = await createBankAccount(user.id, {
      name: "Kopio",
      iban: IBAN_A,
      openingBalance: 0,
      openingDate: "2026-01-01",
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "IBAN_IN_USE" });
  });
});

describe("F52: autodetect never files a statement under an archived account", () => {
  it("a counterparty IBAN of an archived own account does not decide", async () => {
    const active = await createBankAccountRow(user.id, { name: "Aktiivinen", iban: IBAN_B });
    const archived = await createBankAccountRow(user.id, { name: "Käyttötili", iban: IBAN_A });
    await archive(archived.id);
    const csv =
      `Tilinumero;${IBAN_B}\n` +
      "Kirjauspäivä;Summa;Saaja;Saajan tilinumero\n" +
      `05.01.2026;-250,00;Oma siirto;${IBAN_A}\n` +
      "18.01.2026;120,00;Asiakas Oy;\n";
    const response = await upload(csv);
    expect(response.status).toBe(200);
    const { statement } = await readJson(response);
    expect(statement.bankAccountId).toBe(active.id);
  });

  it("a file whose own account is archived goes to the default active account, not the archived one", async () => {
    const active = await createBankAccountRow(user.id, { name: "Aktiivinen", iban: IBAN_B, isDefault: true });
    const archived = await createBankAccountRow(user.id, { name: "Vanha", iban: IBAN_A });
    await archive(archived.id);
    const csv = `Tilinumero;${IBAN_A}\nKirjauspäivä;Summa;Saaja\n05.01.2026;120,00;Asiakas Oy\n`;
    const { statement } = await readJson(await upload(csv));
    expect(statement.bankAccountId).toBe(active.id);
  });

  it("a counterparty IBAN of another active own account does not decide either", async () => {
    const own = await createBankAccountRow(user.id, { name: "Oma", iban: IBAN_B });
    await createBankAccountRow(user.id, { name: "Toinen oma", iban: IBAN_A, isDefault: true });
    const csv =
      `Tilinumero;${IBAN_B}\n` +
      "Kirjauspäivä;Summa;Saaja;Saajan tilinumero\n" +
      `05.01.2026;-250,00;Oma siirto;${IBAN_A}\n`;
    const { statement } = await readJson(await upload(csv));
    expect(statement.bankAccountId).toBe(own.id);
  });

  it("resolveAccountForImport ignores an archived account found by IBAN", async () => {
    const archived = await createBankAccountRow(user.id, { name: "Vanha", iban: IBAN_A });
    await archive(archived.id);
    expect(await resolveAccountForImport(user.id, { iban: IBAN_A })).toBeNull();
  });
});

describe("G30: an account created after the sync adopts the statements of its IBAN", () => {
  async function bankStatement(iban: string, month: string, rows: Array<{ date: string; cents: number }>) {
    const statement = await prisma.statement.create({
      data: {
        userId: user.id,
        fileName: "Pankki",
        fileType: "enablebanking",
        filePath: "enablebanking",
        checksum: `eb:${iban}:${month}`,
        periodMonth: month,
      },
    });
    await prisma.transaction.createMany({
      data: rows.map((row, index) => ({
        statementId: statement.id,
        userId: user.id,
        date: new Date(`${row.date}T00:00:00.000Z`),
        amountCents: row.cents,
        counterparty: "Kauppa",
        bankRef: `eb:${iban}:${month}-${index}`,
        source: "enablebanking",
        iban,
        type: row.cents > 0 ? "tulo" : "meno",
      })),
    });
    return statement;
  }

  it("creating the account links the unlinked bank statements and the balance follows", async () => {
    const statement = await bankStatement(IBAN_A, "2026-09", [
      { date: "2026-09-02", cents: -5000 },
      { date: "2026-09-03", cents: 20_000 },
    ]);
    await bankStatement(IBAN_B, "2026-09", [{ date: "2026-09-04", cents: 999 }]);

    const account = await createBankAccount(user.id, {
      name: "Käyttötili",
      iban: IBAN_A,
      openingBalance: 1000,
      openingDate: "2026-07-01",
    });
    expect((await prisma.statement.findUniqueOrThrow({ where: { id: statement.id } })).bankAccountId).toBe(account.id);
    expect(await prisma.statement.count({ where: { bankAccountId: account.id } })).toBe(1);

    const overview = await getBankOverview(user.id);
    expect(overview.accounts[0].currentBalance).toBe(1150);
    expect(overview.accounts[0].statementCount).toBe(1);
  });

  it("setting the IBAN of an existing account does the same", async () => {
    const statement = await bankStatement(IBAN_A, "2026-08", [{ date: "2026-08-02", cents: 100 }]);
    const account = await createBankAccountRow(user.id, { name: "Ilman IBANia" });
    await updateBankAccount(user.id, account.id, { iban: IBAN_A });
    expect((await prisma.statement.findUniqueOrThrow({ where: { id: statement.id } })).bankAccountId).toBe(account.id);
  });

  it("a statement that already belongs to another account is left alone", async () => {
    const statement = await bankStatement(IBAN_A, "2026-08", [{ date: "2026-08-02", cents: 100 }]);
    const other = await createBankAccountRow(user.id, { name: "Valittu käsin" });
    await prisma.statement.update({ where: { id: statement.id }, data: { bankAccountId: other.id } });
    await createBankAccount(user.id, { name: "Uusi", iban: IBAN_A, openingBalance: 0, openingDate: "2026-01-01" });
    expect((await prisma.statement.findUniqueOrThrow({ where: { id: statement.id } })).bankAccountId).toBe(other.id);
  });

  it("a sync with nothing new still links the statements of an account that was added later", async () => {
    const connection = await prisma.bankConnection.create({
      data: {
        userId: user.id,
        aspspName: "S-Pankki",
        aspspCountry: "FI",
        psuType: "business",
        status: "active",
        sessionIdEnc: encrypt("session-1"),
        validUntil: new Date("2099-01-01T00:00:00.000Z"),
        lastSuccessAt: new Date(),
        accounts: { create: [{ userId: user.id, iban: IBAN_A, label: "Käyttötili", providerAccountUid: "acc-1", inScope: true }] },
      },
    });
    const statement = await bankStatement(IBAN_A, "2026-09", [{ date: "2026-09-02", cents: 100 }]);
    // An account created while the statements were unlinked (data from before the fix).
    const account = await createBankAccountRow(user.id, { name: "Käyttötili", iban: IBAN_A });
    expect((await prisma.statement.findUniqueOrThrow({ where: { id: statement.id } })).bankAccountId).toBeNull();

    const client = {
      getSession: async () => ({ status: "AUTHORIZED" }),
      getAccountBalances: async () => [],
      getAccountTransactions: async () => ({ transactions: [], continuationKey: null }),
    } as unknown as EnableBankingClient;
    await syncBankConnection(user.id, connection.id, { attended: false, client });
    expect((await prisma.statement.findUniqueOrThrow({ where: { id: statement.id } })).bankAccountId).toBe(account.id);
  });
});
