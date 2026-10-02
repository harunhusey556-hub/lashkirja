import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { POST as importCustomers } from "@/app/api/customers/import/route";
import { failNextIdempotencyResponseForTests } from "@/lib/idempotency";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;

const csv = "nimi;sähköposti\nKauneus Oy;laskut@kauneus.fi\nAnna Asiakas;anna@example.com\n;puuttuu@example.com";

beforeEach(async () => {
  await resetDatabase();
  failNextIdempotencyResponseForTests(0);
  user = await createUser();
  cookie = await sessionCookie(user);
});

function commit(key: string | null, body: unknown = { csv, commit: true }) {
  const headers: Record<string, string> = key ? { "idempotency-key": key } : {};
  return importCustomers(buildRequest("POST", "/api/customers/import", body, { cookie, headers }));
}

async function customerCount() {
  return prisma.customer.count({ where: { userId: user.id } });
}

describe("POST /api/customers/import commit with Idempotency-Key", () => {
  it("creates the customers once and replays the answer on a retry", async () => {
    const first = await commit("import-1");
    expect(first.status).toBe(200);
    const firstBody = await readJson(first);
    expect(firstBody.created).toBe(2);
    expect(await customerCount()).toBe(2);

    const retry = await commit("import-1");
    expect(retry.status).toBe(200);
    const retryBody = await readJson(retry);
    expect(retryBody.created).toBe(2);
    expect(retryBody.rows).toEqual(firstBody.rows);
    expect(await customerCount()).toBe(2);
  });

  it("refuses the same key with a different file", async () => {
    await commit("import-2");
    const other = await commit("import-2", { csv: "nimi\nToinen Oy", commit: true });
    expect(other.status).toBe(409);
    expect(await customerCount()).toBe(2);
  });

  it("rolls the rows back when the answer cannot be stored, so the retry imports once", async () => {
    failNextIdempotencyResponseForTests(1);
    const failed = await commit("import-3");
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(await customerCount()).toBe(0);

    const retry = await commit("import-3");
    expect(retry.status).toBe(200);
    expect((await readJson(retry)).created).toBe(2);
    expect(await customerCount()).toBe(2);
  });

  it("a new key is a new import, and a check never claims a key", async () => {
    const check = await importCustomers(
      buildRequest("POST", "/api/customers/import", { csv }, { cookie, headers: { "idempotency-key": "check-1" } })
    );
    expect(check.status).toBe(200);
    expect((await readJson(check)).created).toBe(0);
    expect(await prisma.idempotencyRecord.count({ where: { userId: user.id } })).toBe(0);

    await commit("import-4");
    await commit("import-5");
    expect(await customerCount()).toBe(4);
  });

  it("without a key the commit still imports (older clients)", async () => {
    const response = await commit(null);
    expect(response.status).toBe(200);
    expect((await readJson(response)).created).toBe(2);
  });
});
