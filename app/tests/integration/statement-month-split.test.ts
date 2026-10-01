/**
 * Live-use test 2026-09-30 (F48): a row belongs to the month of its own date.
 * A file that crosses a month boundary is stored as one tiliote per month, so
 * Pankki, Koti and the account's balance table all read the same month for it.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { prisma } from "@/lib/db";
import { readUserUpload } from "@/lib/storage";
import { POST as uploadStatement } from "@/app/api/statements/route";
import { DELETE as deleteStatement } from "@/app/api/statements/[id]/route";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildFormRequest, buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;

const HEADER = "Kirjauspäivä;Summa;Saaja\n";
const crossing =
  HEADER +
  "28.08.2026;-85,00;Elokuun kauppa\n" +
  "30.08.2026;-12,00;Elokuun kahvila\n" +
  "01.09.2026;-10,00;Syyskuun A\n" +
  "09.09.2026;-11,00;Syyskuun B\n" +
  "15.09.2026;-12,50;Syyskuun C\n" +
  "27.09.2026;-14,00;Syyskuun D\n";

function upload(body: string, name = "tiliote.csv") {
  const form = new FormData();
  form.set("file", new File([body], name, { type: "text/csv" }));
  return uploadStatement(buildFormRequest("/api/statements", form, { cookie }));
}

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  fs.rmSync(path.join(process.cwd(), "data", "uploads"), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(path.join(process.cwd(), "data", "uploads"), { recursive: true, force: true });
});

describe("F48: one tiliote per month of the rows", () => {
  it("files every row under the month of its own date", async () => {
    const response = await upload(crossing);
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.count).toBe(6);
    // The month most rows belong to is the one the answer names.
    expect(body.statement.periodMonth).toBe("2026-09");
    expect(body.statements.map((s: { periodMonth: string }) => s.periodMonth).sort()).toEqual(["2026-08", "2026-09"]);

    const rows = await prisma.transaction.findMany({ include: { statement: true } });
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row.statement.periodMonth).toBe(row.date!.toISOString().slice(0, 7));
      expect(row.statement.periodSource).toBe("auto");
    }
    expect(body.transactions).toHaveLength(6);
  });

  it("says that the file was split", async () => {
    const body = await readJson(await upload(crossing));
    expect(body.notice).toContain("2 kuukaudelta");
    const single = await readJson(await upload(HEADER + "01.10.2026;-10,00;Yksi kuukausi\n", "yksi.csv"));
    expect(single.notice ?? "").not.toContain("kuukaudelta");
    expect(single.statements).toHaveLength(1);
  });

  it("the same file again is still refused as already imported", async () => {
    expect((await upload(crossing)).status).toBe(200);
    const again = await upload(crossing);
    expect(again.status).toBe(409);
  });

  it("deleting one month's tiliote leaves the other month and the stored file alone", async () => {
    const body = await readJson(await upload(crossing));
    const august = body.statements.find((s: { periodMonth: string }) => s.periodMonth === "2026-08");
    const september = body.statements.find((s: { periodMonth: string }) => s.periodMonth === "2026-09");

    const first = await deleteStatement(
      buildRequest("DELETE", `/api/statements/${september.id}`, undefined, { cookie }),
      routeContext({ id: september.id })
    );
    expect(first.status).toBe(200);
    expect(await prisma.transaction.count({ where: { statementId: august.id } })).toBe(2);
    await expect(readUserUpload(user.id, path.basename(august.filePath), true)).resolves.toBeInstanceOf(Buffer);

    const last = await deleteStatement(
      buildRequest("DELETE", `/api/statements/${august.id}`, undefined, { cookie }),
      routeContext({ id: august.id })
    );
    expect(last.status).toBe(200);
    await expect(readUserUpload(user.id, path.basename(august.filePath), true)).rejects.toBeTruthy();
  });

  it("a closed month's rows are still left out, and the rest is split as usual", async () => {
    await prisma.user.update({ where: { id: user.id }, data: { booksLockedThrough: "2026-08" } });
    const body = await readJson(await upload(crossing));
    expect(body.count).toBe(4);
    expect(body.heldBack).toBe(2);
    expect(body.statements).toHaveLength(1);
    expect(body.statement.periodMonth).toBe("2026-09");
  });
});
