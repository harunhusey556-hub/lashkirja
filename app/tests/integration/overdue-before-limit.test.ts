import { beforeEach, describe, expect, it } from "vitest";
import { GET as listSales } from "@/app/api/invoices/route";
import { GET as listPurchases } from "@/app/api/purchase-invoices/route";
import { prisma } from "@/lib/db";
import { createReferenceNumber } from "@/lib/finnish-reference";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

describe("overdue lists filter before the page limit", () => {
  it("returns a sales invoice that sits past a naive take(200)", async () => {
    const customer = await prisma.customer.create({
      data: { userId: user.id, name: "Anna Asiakas" },
    });
    const recent = Array.from({ length: 201 }, (_, index) => {
      const number = index + 2;
      return {
        userId: user.id,
        customerId: customer.id,
        number,
        reference: createReferenceNumber(1_000_000 + number),
        issueDate: new Date(Date.UTC(2026, 7, 1) + index * 86_400_000),
        dueDate: new Date(Date.UTC(2027, 0, 15)),
        status: "sent",
        grossCents: 1000,
        netCents: 800,
        vatCents: 200,
      };
    });
    await prisma.salesInvoice.createMany({ data: recent });
    const overdue = await prisma.salesInvoice.create({
      data: {
        userId: user.id,
        customerId: customer.id,
        number: 1,
        reference: createReferenceNumber(1_000_001),
        issueDate: new Date(Date.UTC(2019, 0, 1)),
        dueDate: new Date(Date.UTC(2019, 1, 1)),
        status: "sent",
        grossCents: 2500,
        netCents: 2000,
        vatCents: 500,
      },
    });

    const naive = await prisma.salesInvoice.findMany({
      where: { userId: user.id },
      orderBy: [{ issueDate: "desc" }, { number: "desc" }],
      take: 200,
      select: { id: true },
    });
    expect(naive.some((row) => row.id === overdue.id)).toBe(false);

    const response = await listSales(
      buildRequest("GET", "/api/invoices?status=overdue", undefined, { cookie })
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.invoices.map((invoice: { id: string }) => invoice.id)).toEqual([overdue.id]);
    expect(body.invoices[0].displayStatus).toBe("overdue");
  });

  it("returns a purchase invoice that sits past a naive take(200)", async () => {
    await prisma.purchaseInvoice.createMany({
      data: Array.from({ length: 200 }, (_, index) => ({
        userId: user.id,
        supplierName: `Vanha ${index}`,
        issueDate: new Date(Date.UTC(2018, 0, 1)),
        dueDate: new Date(Date.UTC(2018, 0, 1) + index * 86_400_000),
        status: "cancelled",
        grossCents: 100,
        netCents: 100,
        vatCents: 0,
      })),
    });
    const overdue = await prisma.purchaseInvoice.create({
      data: {
        userId: user.id,
        supplierName: "Erääntynyt Oy",
        issueDate: new Date(Date.UTC(2024, 0, 1)),
        dueDate: new Date(Date.UTC(2024, 0, 15)),
        status: "open",
        grossCents: 4400,
        netCents: 3500,
        vatCents: 900,
      },
    });
    await prisma.purchaseInvoice.create({
      data: {
        userId: user.id,
        supplierName: "Tuleva Oy",
        issueDate: new Date(Date.UTC(2026, 8, 1)),
        dueDate: new Date(Date.UTC(2027, 5, 1)),
        status: "open",
        grossCents: 1000,
        netCents: 800,
        vatCents: 200,
      },
    });

    const naive = await prisma.purchaseInvoice.findMany({
      where: { userId: user.id },
      orderBy: [{ dueDate: "asc" }, { createdAt: "asc" }],
      take: 200,
      select: { id: true },
    });
    expect(naive.some((row) => row.id === overdue.id)).toBe(false);

    const response = await listPurchases(
      buildRequest("GET", "/api/purchase-invoices?status=overdue", undefined, { cookie })
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.invoices.map((invoice: { id: string }) => invoice.id)).toEqual([overdue.id]);
    expect(body.invoices[0].displayStatus).toBe("overdue");
  });
});
