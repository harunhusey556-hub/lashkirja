import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { prisma } from "@/lib/db";
import { POST as uploadStatement } from "@/app/api/statements/route";
import { DELETE as deleteStatement } from "@/app/api/statements/[id]/route";
import { createStatementWithTransactions, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildFormRequest, buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;

const HEADER = "Kirjauspäivä;Summa;Saaja\n";

function upload(body: string, name = "tiliote.csv", fields: Record<string, string> = {}) {
  const form = new FormData();
  form.set("file", new File([body], name, { type: "text/csv" }));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return uploadStatement(buildFormRequest("/api/statements", form, { cookie }));
}

const lockThrough = (month: string | null) =>
  prisma.user.update({ where: { id: user.id }, data: { booksLockedThrough: month } });

const uploadsDir = () => path.join(process.cwd(), "data", "uploads", user.id);
const uploadedFiles = () => (fs.existsSync(uploadsDir()) ? fs.readdirSync(uploadsDir()) : []);

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  fs.rmSync(path.join(process.cwd(), "data", "uploads"), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(path.join(process.cwd(), "data", "uploads"), { recursive: true, force: true });
});

const september =
  HEADER +
  "01.09.2026;-10,00;Kahvila\n05.09.2026;-11,00;Kioski\n10.09.2026;-12,00;Kauppa\n15.09.2026;-13,00;Posti\n20.09.2026;-14,00;Bussi\n25.09.2026;-15,00;Apteekki\n";

describe("V26: the month and the lock follow the rows that are stored, not the file", () => {
  it("a rolling export of known September rows and two new October rows goes into October", async () => {
    expect((await upload(september, "syys.csv")).status).toBe(200);
    const rolling = september + "03.10.2026;-5,00;Uusi A\n04.10.2026;-6,00;Uusi B\n";
    const response = await upload(rolling, "rolling.csv");
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.count).toBe(2);
    expect(body.statement.periodMonth).toBe("2026-10");
  });

  it("with September closed the same export is accepted, because only open-month rows are new", async () => {
    expect((await upload(september, "syys.csv")).status).toBe(200);
    await lockThrough("2026-09");
    const rolling = september + "03.10.2026;-5,00;Uusi A\n04.10.2026;-6,00;Uusi B\n";
    const response = await upload(rolling, "rolling.csv");
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.count).toBe(2);
    expect(body.notice ?? "").not.toMatch(/suljet/);
  });
});

describe("R54: a file import honours the lock for every row date", () => {
  it("leaves rows of a closed month out, says so, and drafts nothing for them", async () => {
    await lockThrough("2026-09");
    const mixed =
      HEADER +
      "28.09.2026;40,00;Syyskuun Asiakas\n29.09.2026;-9,00;Syyskuun Kauppa\n02.10.2026;50,00;Lokakuun Asiakas\n03.10.2026;-8,00;Lokakuun Kauppa\n04.10.2026;-7,00;Lokakuun Posti\n";
    const response = await upload(mixed, "yli.csv");
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.count).toBe(3);
    expect(body.heldBack).toBe(2);
    expect(body.notice).toBe("2 tapahtumaa kuuluu suljettuun kuukauteen, joten niitä ei tuotu.");
    expect(body.statement.periodMonth).toBe("2026-10");
    const rows = await prisma.transaction.findMany({ where: { statement: { userId: user.id } } });
    expect(rows.every((row) => row.date && row.date.toISOString() >= "2026-10-01")).toBe(true);
    const drafts = await prisma.receipt.findMany({ where: { userId: user.id, source: "auto_income" } });
    expect(drafts.every((receipt) => receipt.date && receipt.date.toISOString() >= "2026-10-01")).toBe(true);
  });

  it("after the month is reopened the same file brings in the rows it held back, and only those", async () => {
    await lockThrough("2026-09");
    const mixed =
      HEADER +
      "28.09.2026;40,00;Syyskuun Asiakas\n29.09.2026;-9,00;Syyskuun Kauppa\n02.10.2026;50,00;Lokakuun Asiakas\n";
    const first = await upload(mixed, "yli.csv");
    expect((await readJson(first)).heldBack).toBe(2);
    await lockThrough(null);

    const again = await upload(mixed, "yli.csv");
    expect(again.status).toBe(200);
    const body = await readJson(again);
    expect(body.count).toBe(2);
    expect(body.statement.periodMonth).toBe("2026-09");
    expect(await prisma.transaction.count({ where: { statement: { userId: user.id } } })).toBe(3);

    const third = await upload(mixed, "yli.csv");
    expect(third.status).toBe(409);
    expect((await readJson(third)).skippedDuplicates).toBe(3);
  });

  it("refuses a file whose every new row is in a closed month and leaves nothing behind", async () => {
    await lockThrough("2026-09");
    const response = await upload(september, "syys.csv");
    expect(response.status).toBe(409);
    expect((await readJson(response)).error.code).toBe("PERIOD_LOCKED");
    expect(await prisma.statement.count()).toBe(0);
    expect(uploadedFiles()).toHaveLength(0);
  });
});

describe("V21: deleting a statement honours the lock for every row date", () => {
  it("refuses while a row dated in a closed month is inside, and keeps every row", async () => {
    const statement = await createStatementWithTransactions(user.id, {
      periodMonth: "2026-10",
      transactions: [
        { date: "2026-10-05", amountCents: -500 },
        { date: "2026-10-06", amountCents: -600 },
        { date: "2026-09-29", amountCents: -700 },
      ],
    });
    await lockThrough("2026-09");
    const response = await deleteStatement(
      buildRequest("DELETE", `/api/statements/${statement.id}`, undefined, { cookie }),
      routeContext({ id: statement.id })
    );
    expect(response.status).toBe(409);
    expect((await readJson(response)).error.code).toBe("PERIOD_LOCKED");
    expect(await prisma.transaction.count({ where: { statementId: statement.id } })).toBe(3);
    expect(await prisma.statement.count({ where: { id: statement.id } })).toBe(1);
  });

  it("deletes a statement whose rows are all in open months", async () => {
    const statement = await createStatementWithTransactions(user.id, {
      periodMonth: "2026-10",
      transactions: [{ date: "2026-10-05", amountCents: -500 }],
    });
    await lockThrough("2026-09");
    const response = await deleteStatement(
      buildRequest("DELETE", `/api/statements/${statement.id}`, undefined, { cookie }),
      routeContext({ id: statement.id })
    );
    expect(response.status).toBe(200);
  });
});

describe("V28: a refused upload leaves no file behind", () => {
  it("an account that is not the user's answers 404 and removes the stored bytes", async () => {
    const response = await upload(september, "syys.csv", { bankAccountId: "00000000-0000-4000-8000-000000000000" });
    expect(response.status).toBe(404);
    expect(uploadedFiles()).toHaveLength(0);
  });
});
