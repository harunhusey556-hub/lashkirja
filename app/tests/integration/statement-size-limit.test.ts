/**
 * Beta audit 2026-10: a 17 MB proxy body cap stood in front of the 20 MB statement limit, so a
 * statement between the two reached the route cut short and failed with a 500. A handler call never
 * passes through the proxy; that the cap holds a whole statement is next-config-body-cap.test.ts.
 * This pins the product rule the cap has to carry.
 */
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { POST as uploadStatement } from "@/app/api/statements/route";
import { MAX_STATEMENT_BYTES, MAX_STATEMENT_REQUEST_BYTES } from "@/lib/storage";
import { createUser, resetDatabase } from "./helpers/factories";
import { buildFormRequest, readJson, sessionCookie } from "./helpers/http";

const MIB = 1024 * 1024;
const FIRST_ROWS = "Kirjauspäivä;Summa;Saaja\n05.01.2026;120,00;Asiakas Oy\n";

let cookie: string;

beforeEach(async () => {
  await resetDatabase();
  cookie = await sessionCookie(await createUser());
});

afterAll(() => {
  fs.rmSync(path.join(process.cwd(), "data", "uploads"), { recursive: true, force: true });
});

/** One real row, then blank lines up to the size: cheap to parse, and still a CSV. */
function csvOfBytes(bytes: number): string {
  return FIRST_ROWS + "\n".repeat(bytes - Buffer.byteLength(FIRST_ROWS));
}

function upload(body: string, headers: Record<string, string> = {}) {
  const form = new FormData();
  form.set("file", new File([body], "tiliote.csv", { type: "text/csv" }));
  return uploadStatement(buildFormRequest("/api/statements", form, { cookie, headers }));
}

describe("POST /api/statements size limits", () => {
  it("imports a statement between the old 17 MB proxy cap and the 20 MB limit", async () => {
    const body = csvOfBytes(19 * MIB);
    const response = await upload(body, { "content-length": String(Buffer.byteLength(body) + 1024) });
    expect(response.status).toBe(200);
    expect((await readJson(response)).count).toBe(1);
  });

  it("takes a statement of exactly the limit", async () => {
    const response = await upload(csvOfBytes(MAX_STATEMENT_BYTES));
    expect(response.status).toBe(200);
  });

  it("refuses a statement one byte over the limit in Finnish, naming the limit", async () => {
    const response = await upload(csvOfBytes(MAX_STATEMENT_BYTES + 1));
    expect(response.status).toBe(413);
    expect((await readJson(response)).error).toBe("Tiedosto on liian suuri (enintään 20 Mt)");
  });

  it("refuses a request over the statement request limit before reading it", async () => {
    const response = await upload("x", { "content-length": String(MAX_STATEMENT_REQUEST_BYTES + 1) });
    expect(response.status).toBe(413);
    expect((await readJson(response)).error).toBe("Pyyntö on liian suuri");
  });
});
