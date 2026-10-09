/**
 * Audit 2026-10-09 (agent C, flows 4): which account a statement belongs to.
 * - A file naming its own account (Tilinumero / IBAN line, camt Acct) that is none of the owner's
 *   accounts was filed under the default account without a word.
 * - The IBAN guessed from mentions (a payee's, a landlord's) was written into an account without one.
 * - A file uploaded before its account existed was never adopted, and a re-upload doubled its rows.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { prisma } from "@/lib/db";
import { POST as uploadStatement } from "@/app/api/statements/route";
import { createBankAccount } from "@/lib/bank-accounts";
import { createBankAccountRow, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildFormRequest, readJson, sessionCookie } from "./helpers/http";

const OWN = "FI2112345600000785";
const OTHER = "FI4950009420028730";
const LANDLORD = "FI5810171000000122";
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

async function upload(body: string, name = "tiliote.csv") {
  const form = new FormData();
  form.set("file", new File([body], name, { type: "text/csv" }));
  const response = await uploadStatement(buildFormRequest("/api/statements", form, { cookie }));
  return { status: response.status, body: await readJson(response) };
}

const labelled = (iban: string, day = "05.09.2026") => `Tilinumero;${iban}\nKirjauspäivä;Summa;Saaja\n${day};-120,00;Kauppa Oy\n${day};50,00;Asiakas Oy\n`;

describe("the statement's own account", () => {
  it("a file of an account the owner does not have is not put on another account", async () => {
    const mine = await createBankAccountRow(user.id, { name: "Nordea", iban: OWN, isDefault: true });
    const { status, body } = await upload(labelled(OTHER));
    expect(status).toBe(200);
    expect(body.statement.bankAccountId).toBeNull();
    expect(body.notice).toContain("FI49 5000 9420 0287 30");
    expect(await prisma.statement.count({ where: { bankAccountId: mine.id } })).toBe(0);
  });

  it("an account without an IBAN takes a labelled own IBAN, never a payee's", async () => {
    const plain = await createBankAccountRow(user.id, { name: "Käyttötili", isDefault: true });
    await upload(`Kirjauspäivä;Summa;Saaja;Saajan tilinumero\n05.09.2026;-800,00;Vuokranantaja Oy;${LANDLORD}\n`);
    expect((await prisma.bankAccount.findUniqueOrThrow({ where: { id: plain.id } })).iban).toBeNull();
    await upload(labelled(OWN, "06.09.2026"));
    expect((await prisma.bankAccount.findUniqueOrThrow({ where: { id: plain.id } })).iban).toBe(OWN);
  });

  it("a file uploaded before its account existed joins the account, and is not stored twice", async () => {
    const first = await upload(labelled(OWN));
    expect(first.status).toBe(200);
    expect(first.body.statement.bankAccountId).toBeNull();
    const account = await createBankAccount(user.id, { name: "Nordea", iban: OWN, openingBalance: 0, openingDate: "2026-09-01" });
    expect((await prisma.statement.findUniqueOrThrow({ where: { id: first.body.statement.id } })).bankAccountId).toBe(account.id);
    const again = await upload(labelled(OWN), "sama-uudelleen.csv");
    expect(again.status).toBe(409);
    expect(await prisma.transaction.count({ where: { statement: { userId: user.id } } })).toBe(2);
  });
});
