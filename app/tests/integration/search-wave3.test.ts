/**
 * Wave 3, lane F2 (F09): list searches fold Finnish and Turkish letters, find a
 * customer by Y-tunnus and e-mail, and read % and _ literally.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { GET as listCustomers, POST as createCustomer } from "@/app/api/customers/route";
import { GET as listInvoices, POST as createInvoice } from "@/app/api/invoices/route";
import { GET as receiptCounts } from "@/app/api/receipts/counts/route";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;

async function customer(body: Record<string, unknown>) {
  const response = await createCustomer(buildRequest("POST", "/api/customers", body, { cookie }));
  expect(response.status).toBe(201);
  return (await readJson(response)).customer as { id: string };
}

async function names(path: string): Promise<string[]> {
  const body = await readJson(await listCustomers(buildRequest("GET", path, undefined, { cookie })));
  return body.customers.map((row: { name: string }) => row.name);
}

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

describe("customer search", () => {
  it("is case-insensitive for Finnish and Turkish letters", async () => {
    await customer({ name: "Äiti Oy" });
    await customer({ name: "Öljy Ab" });
    await customer({ name: "Ünlü Ltd" });
    await customer({ name: "ŞÜKRÜ Oy" });
    for (const q of ["äiti", "Äiti", "ÄITI"]) {
      expect(await names(`/api/customers?search=${encodeURIComponent(q)}`)).toEqual(["Äiti Oy"]);
    }
    expect(await names(`/api/customers?search=${encodeURIComponent("öljy")}`)).toEqual(["Öljy Ab"]);
    expect(await names(`/api/customers?search=${encodeURIComponent("ünlü")}`)).toEqual(["Ünlü Ltd"]);
    expect(await names(`/api/customers?search=${encodeURIComponent("şükrü")}`)).toEqual(["ŞÜKRÜ Oy"]);
  });

  it("finds by Y-tunnus (with or without the dash) and by e-mail", async () => {
    await customer({ name: "Liisa Oy", businessId: "0201256-6", email: "laskut@example.invalid" });
    await customer({ name: "Muu Oy" });
    expect(await names("/api/customers?search=0201256-6")).toEqual(["Liisa Oy"]);
    expect(await names("/api/customers?search=02012566")).toEqual(["Liisa Oy"]);
    expect(await names("/api/customers?search=EXAMPLE.invalid")).toEqual(["Liisa Oy"]);
  });

  it("treats % and _ literally", async () => {
    await customer({ name: "Anna" });
    await customer({ name: "Alennus 50% Oy" });
    expect(await names("/api/customers?search=%25")).toEqual(["Alennus 50% Oy"]);
    expect(await names("/api/customers?search=_")).toEqual([]);
  });
});

describe("invoice search by customer", () => {
  it("follows the same rules", async () => {
    const aiti = await customer({ name: "Äiti Oy", businessId: "0201256-6" });
    const other = await customer({ name: "Muu Oy" });
    for (const id of [aiti.id, other.id]) {
      const response = await createInvoice(
        buildRequest(
          "POST",
          "/api/invoices",
          {
            customerId: id,
            issueDate: "2025-03-10",
            lines: [{ description: "Työ", quantity: 1, unitPrice: 100, vatRate: 25.5 }],
          },
          { cookie }
        )
      );
      expect(response.status).toBe(201);
    }
    const ids = async (q: string) =>
      (
        await readJson(
          await listInvoices(buildRequest("GET", `/api/invoices?search=${encodeURIComponent(q)}`, undefined, { cookie }))
        )
      ).invoices.map((row: { customerId?: string; customer?: { id: string } }) => row.customerId ?? row.customer?.id);
    expect(await ids("äiti")).toEqual([aiti.id]);
    expect(await ids("ÄITI")).toEqual([aiti.id]);
    expect(await ids("0201256-6")).toEqual([aiti.id]);
    expect(await ids("%")).toEqual([]);
    expect(await ids("_")).toEqual([]);
  });
});

describe("receipt search", () => {
  it("folds case for the vendor and reads % literally", async () => {
    for (const vendor of ["Äitiys Kauppa", "Tukku Oy"]) {
      await prisma.receipt.create({
        data: {
          userId: user.id,
          type: "meno",
          vendor,
          date: new Date("2026-01-15T00:00:00Z"),
          totalAmountCents: 1000,
          reviewStatus: "approved",
          filePath: "/tmp/k.pdf",
          fileName: "k.pdf",
        },
      });
    }
    const all = async (q: string) =>
      (await readJson(await receiptCounts(buildRequest("GET", `/api/receipts/counts?q=${encodeURIComponent(q)}`, undefined, { cookie })))).counts
        .all;
    expect(await all("äitiys")).toBe(1);
    expect(await all("ÄITIYS")).toBe(1);
    expect(await all("%")).toBe(0);
  });
});
