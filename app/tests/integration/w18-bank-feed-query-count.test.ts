import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * W18 perf guard: the bank feed's SQL query count is a small constant. It must not grow with the
 * number of rows or statements (an N+1 per row or per statement would show here first). The app's
 * Prisma client is swapped for one with query events, on the same per-file database.
 */
const counter = vi.hoisted(() => ({ queries: 0 }));

vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@/generated/prisma/client");
  const { PrismaLibSql } = await import("@prisma/adapter-libsql");
  const prisma = new PrismaClient({
    adapter: new PrismaLibSql({ url: process.env.DATABASE_URL! }),
    log: [{ emit: "event", level: "query" }],
  });
  prisma.$on("query", () => {
    counter.queries += 1;
  });
  return { prisma, hardenLocalDatabasePermissions: () => undefined };
});

import { GET as listStatements } from "@/app/api/statements/route";
import { createBankAccountRow, createReceipt, createStatementWithTransactions, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

/** Queries for one feed page (session read included); the bound leaves room, not N. */
const FEED_PAGE_QUERY_LIMIT = 20;

let user: TestUser;
let cookie: string;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

async function seed(statements: number, rowsPerStatement: number) {
  const account = await createBankAccountRow(user.id, { name: "Tili", iban: "FI2112345600000785", isDefault: true });
  for (let s = 0; s < statements; s++) {
    const month = `2025-${String((s % 12) + 1).padStart(2, "0")}`;
    await createStatementWithTransactions(user.id, {
      bankAccountId: account.id,
      periodMonth: month,
      transactions: Array.from({ length: rowsPerStatement }, (_, i) => ({
        date: `${month}-${String((i % 27) + 1).padStart(2, "0")}`,
        amountCents: -(100 + i),
        counterparty: `Kauppa ${i}`,
      })),
    });
  }
  for (let r = 0; r < 20; r++) await createReceipt(user.id, { totalAmountCents: 100 + r, vendor: `Kauppa ${r}` });
}

async function pageQueries(url: string) {
  counter.queries = 0;
  const response = await listStatements(buildRequest("GET", url, undefined, { cookie }));
  expect(response.status).toBe(200);
  await readJson(response);
  return counter.queries;
}

describe("bank feed query count", () => {
  it("a page costs the same few queries for a small and a large ledger", async () => {
    await seed(2, 30);
    const small = await pageQueries("/api/statements?cursor=");
    const smallSummary = await pageQueries("/api/statements?view=summary");
    await resetDatabase();
    user = await createUser();
    cookie = await sessionCookie(user);
    await seed(12, 60);
    const large = await pageQueries("/api/statements?cursor=");
    const largeSummary = await pageQueries("/api/statements?view=summary");

    expect(large).toBeLessThanOrEqual(FEED_PAGE_QUERY_LIMIT);
    expect(large).toBe(small);
    expect(largeSummary).toBeLessThanOrEqual(FEED_PAGE_QUERY_LIMIT);
    expect(largeSummary).toBe(smallSummary);
  });
});
