import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * W24 perf guard: a Kuitit page and a Myynti page cost the same few queries for a small and a large
 * book (an N+1 per row would show here first). The app's Prisma client is swapped for one with
 * query events, on the same per-file database (as in w18-bank-feed-query-count).
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

import { GET as listReceipts } from "@/app/api/receipts/route";
import { GET as listInvoicesRoute } from "@/app/api/invoices/route";
import { createCustomer } from "@/lib/customers";
import { createInvoice } from "@/lib/sales-invoices";
import { createReceipt, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

/** Queries for one page (session read included); the bound leaves room, not N. */
const PAGE_QUERY_LIMIT = 15;

let user: TestUser;
let cookie: string;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

async function seed(receipts: number, invoices: number) {
  for (let i = 0; i < receipts; i++) await createReceipt(user.id, { date: `2026-0${(i % 9) + 1}-10` });
  const customer = await createCustomer(user.id, { name: "Asiakas Oy" });
  for (let i = 0; i < invoices; i++) {
    await createInvoice(user.id, { customerId: customer.id, issueDate: "2026-03-10", lines: [{ description: "Työ", quantity: 1, unitPrice: 10, vatRate: 25.5 }] });
  }
}

async function queriesFor(route: (req: ReturnType<typeof buildRequest>) => Promise<Response>, url: string) {
  counter.queries = 0;
  const response = await route(buildRequest("GET", url, undefined, { cookie }));
  expect(response.status).toBe(200);
  await readJson(response);
  return counter.queries;
}

describe("list page query count", () => {
  it("is the same few queries for 10 and 120 rows", async () => {
    await seed(10, 3);
    const smallReceipts = await queriesFor(listReceipts, "/api/receipts?kind=receipt&cursor=&limit=50");
    const smallInvoices = await queriesFor(listInvoicesRoute, "/api/invoices?cursor=&limit=50");
    await resetDatabase();
    user = await createUser();
    cookie = await sessionCookie(user);
    await seed(120, 60);
    const largeReceipts = await queriesFor(listReceipts, "/api/receipts?kind=receipt&cursor=&limit=50");
    const largeInvoices = await queriesFor(listInvoicesRoute, "/api/invoices?cursor=&limit=50");

    expect(largeReceipts).toBeLessThanOrEqual(PAGE_QUERY_LIMIT);
    expect(largeReceipts).toBe(smallReceipts);
    expect(largeInvoices).toBeLessThanOrEqual(PAGE_QUERY_LIMIT);
    expect(largeInvoices).toBe(smallInvoices);
  });
});
