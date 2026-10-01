import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { prisma } from "@/lib/db";
import { POST as uploadStatement } from "@/app/api/statements/route";
import {
  createBankAccountRow,
  createStatementWithTransactions,
  createUser,
  resetDatabase,
  type TestUser,
} from "./helpers/factories";
import { buildFormRequest, readJson, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;

const HEADER = "Kirjauspäivä;Summa;Saaja\n";

function upload(body: string, name = "tiliote.csv", fields: Record<string, string> = {}) {
  const form = new FormData();
  form.set("file", new File([body], name, { type: "text/csv" }));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return uploadStatement(buildFormRequest("/api/statements", form, { cookie }));
}

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

afterAll(() => {
  fs.rmSync(path.join(process.cwd(), "data", "uploads"), { recursive: true, force: true });
});

describe("F47: an export that overlaps an earlier one does not double its rows", () => {
  const fileA = HEADER + "23.09.2026;-24,90;Spotify\n24.09.2026;1 234,56;MobilePay Toinen Asiakas\n";
  // A wider export that repeats both rows and adds two new ones.
  const fileB =
    HEADER +
    "28.08.2026;-10,00;Kahvila\n23.09.2026;-24,90;Spotify\n24.09.2026;1 234,56;MobilePay Toinen Asiakas\n27.09.2026;50,00;MobilePay Uusi Asiakas\n";

  it("skips the rows already stored and tells the owner in one sentence", async () => {
    expect((await upload(fileA, "a.csv")).status).toBe(200);
    const second = await upload(fileB, "b.csv");
    expect(second.status).toBe(200);
    const body = await readJson(second);

    expect(body.count).toBe(2);
    expect(body.skippedDuplicates).toBe(2);
    // The two new rows are dated in two months, so the answer also says the file was split (F48).
    expect(body.notice).toContain("2 tapahtumaa oli jo tuotu aiemmin, joten ne ohitettiin.");
    expect(await prisma.transaction.count()).toBe(4);
    expect(await prisma.transaction.count({ where: { counterparty: "Spotify" } })).toBe(1);
    // One sale draft per payment (settlement), not one per copy.
    expect(await prisma.receipt.count({ where: { source: "auto_income" } })).toBe(2);
  });

  it("answers 409 and creates no statement when every row is already stored", async () => {
    expect((await upload(fileA, "a.csv")).status).toBe(200);
    // Same rows, different bytes (a trailing blank line), so the file hash does not catch it.
    const again = await upload(fileA + "\n", "a2.csv");
    expect(again.status).toBe(409);
    expect((await readJson(again)).error).toMatch(/jo tuotu/);
    expect(await prisma.statement.count()).toBe(1);
    expect(await prisma.transaction.count()).toBe(2);
    expect(fs.readdirSync(path.join(process.cwd(), "data", "uploads", user.id))).toHaveLength(1);
  });

  it("keeps two genuine identical rows of one file, and both again only once", async () => {
    const twins = HEADER + "23.09.2026;-4,50;Kahvila\n23.09.2026;-4,50;Kahvila\n";
    const first = await readJson(await upload(twins, "twins.csv"));
    expect(first.count).toBe(2);
    expect(first.skippedDuplicates).toBe(0);

    const more = await readJson(await upload(twins + "24.09.2026;-3,00;Kioski\n", "twins2.csv"));
    expect(more.count).toBe(1);
    expect(more.skippedDuplicates).toBe(2);
    expect(await prisma.transaction.count({ where: { counterparty: "Kahvila" } })).toBe(2);
  });

  it("does not compare across bank accounts", async () => {
    const a = await createBankAccountRow(user.id, { name: "Nordea" });
    const b = await createBankAccountRow(user.id, { name: "OP" });
    expect((await upload(fileA, "a.csv", { bankAccountId: a.id })).status).toBe(200);
    const other = await upload(fileA + "\n", "a-op.csv", { bankAccountId: b.id });
    expect(other.status).toBe(200);
    expect(await prisma.transaction.count()).toBe(4);
  });
});

describe("G36: a tiliote file that overlaps the bank feed does not duplicate the overlap", () => {
  it("skips rows the feed already delivered for the same account", async () => {
    const account = await createBankAccountRow(user.id, { name: "Nordea", iban: "FI2112345600000785" });
    const feed = await createStatementWithTransactions(user.id, {
      bankAccountId: account.id,
      periodMonth: "2026-09",
      transactions: [
        { date: "2026-09-01", amountCents: -35_90, counterparty: "Kauppa Oy" },
        { date: "2026-09-15", amountCents: -12_50, counterparty: "Kahvila" },
      ],
    });
    await prisma.transaction.updateMany({
      where: { statementId: feed.id },
      data: { source: "enablebanking", iban: "FI2112345600000785" },
    });

    const file =
      HEADER + "01.09.2026;-35,90;KAUPPA OY\n15.09.2026;-12,50;Kahvila\n20.09.2026;-8,00;Uusi kauppa\n";
    const response = await upload(file, "syys.csv", { bankAccountId: account.id });
    expect(response.status).toBe(200);
    const body = await readJson(response);

    expect(body.skippedDuplicates).toBe(2);
    expect(body.count).toBe(1);
    expect(await prisma.transaction.count({ where: { source: "file" } })).toBe(1);
    expect(await prisma.transaction.count()).toBe(3);
  });
});

describe("G20: the same file twice at once", () => {
  it("answers one request with 200 and the other with the same 409 as a sequential repeat", async () => {
    const body = HEADER + "23.09.2026;-24,90;Spotify\n24.09.2026;50,00;MobilePay asiakas\n";
    const [one, two] = await Promise.all([upload(body, "a.csv"), upload(body, "b.csv")]);
    const statuses = [one.status, two.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = one.status === 409 ? one : two;
    const message = await readJson(loser);
    expect(message.error).toMatch(/Tämä tiliote on jo tuotu aiemmin/);
    expect(message.statementId).toBeTruthy();
    expect(await prisma.statement.count()).toBe(1);
    expect(await prisma.transaction.count()).toBe(2);
    expect(fs.readdirSync(path.join(process.cwd(), "data", "uploads", user.id))).toHaveLength(1);
  });
});

describe("F46: an unusable file is a 4xx with the parser's own reason", () => {
  it.each([
    ["only a header row", HEADER, "Tiliotteelta ei löytynyt tapahtumia"],
    ["unrecognised columns", "Foo;Bar;Baz\n1;2;3\n", "CSV:n sarakkeita ei tunnistettu"],
    ["an unclosed quote", HEADER + '23.09.2026;-4,50;"Kahvila\n', "CSV:ssä on sulkematon lainausmerkki"],
    ["a missing amount", HEADER + "23.09.2026;abc;Kahvila\n", "puuttuu summa"],
  ])("%s", async (_label, body, message) => {
    const response = await upload(body);
    expect(response.status).toBe(422);
    expect((await readJson(response)).error).toContain(message);
    expect(await prisma.statement.count()).toBe(0);
  });

  it("an empty file is a 400, not a 413", async () => {
    const response = await upload("");
    expect(response.status).toBe(400);
    expect((await readJson(response)).error).toBe("Tiedosto on tyhjä");
  });
});
