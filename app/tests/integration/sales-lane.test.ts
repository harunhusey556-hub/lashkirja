/**
 * Quality batch 1, lane `sales`: the server side of the confirmations and
 * the new list and export options.
 * - SALES-05: the recurring run preview creates nothing.
 * - SALES-06: the payment matching preview books nothing.
 * - SALES-10: invoice search.
 * - SALES-21: exports follow the chosen year; the package takes a quarter or a year.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { POST as createCustomer } from "@/app/api/customers/route";
import { GET as listInvoices, POST as createInvoice } from "@/app/api/invoices/route";
import { POST as setStatus } from "@/app/api/invoices/[id]/status/route";
import { GET as previewMatch, POST as runMatch } from "@/app/api/invoices/match/route";
import { POST as createRecurring } from "@/app/api/recurring-invoices/route";
import { GET as previewRun } from "@/app/api/recurring-invoices/run/route";
import { GET as exportCsv } from "@/app/api/export/route";
import { GET as exportPackage } from "@/app/api/export/package/route";
import { readStoredZip } from "@/lib/zip-store";
import {
  createReceipt,
  createStatementWithTransactions,
  createUser,
  resetDatabase,
  type TestUser,
} from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;
let customerId: string;

async function makeInvoice(issueDate = "2025-03-10", unitPrice = 100, customer = customerId) {
  const response = await createInvoice(
    buildRequest(
      "POST",
      "/api/invoices",
      {
        customerId: customer,
        issueDate,
        lines: [{ description: "Ripsienpidennys", quantity: 1, unitPrice, vatRate: 25.5 }],
      },
      { cookie }
    )
  );
  expect(response.status).toBe(201);
  return (await readJson(response)).invoice as { id: string; number: number; reference: string };
}

async function send(id: string) {
  await setStatus(
    buildRequest("POST", `/api/invoices/${id}/status`, { status: "sent" }, { cookie }),
    routeContext({ id })
  );
}

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  const response = await createCustomer(
    buildRequest("POST", "/api/customers", { name: "Anna Asiakas", email: "anna@example.fi" }, { cookie })
  );
  customerId = (await readJson(response)).customer.id;
});

describe("GET /api/invoices?search=", () => {
  it("finds by customer name, by invoice number and by reference", async () => {
    const other = await createCustomer(
      buildRequest("POST", "/api/customers", { name: "Kauneus Oy" }, { cookie })
    );
    const otherId = (await readJson(other)).customer.id;
    const anna = await makeInvoice();
    const kauneus = await makeInvoice("2025-03-11", 50, otherId);

    const byName = await readJson(
      await listInvoices(buildRequest("GET", "/api/invoices?search=Kauneus", undefined, { cookie }))
    );
    expect(byName.invoices.map((row: { id: string }) => row.id)).toEqual([kauneus.id]);

    const byNumber = await readJson(
      await listInvoices(buildRequest("GET", `/api/invoices?search=${anna.number}`, undefined, { cookie }))
    );
    expect(byNumber.invoices.map((row: { id: string }) => row.id)).toContain(anna.id);

    const byReference = await readJson(
      await listInvoices(
        buildRequest("GET", `/api/invoices?search=${kauneus.reference.replace(/\s/g, "")}`, undefined, { cookie })
      )
    );
    expect(byReference.invoices.map((row: { id: string }) => row.id)).toContain(kauneus.id);
  });
});

describe("GET /api/invoices/match (preview)", () => {
  it("lists what a run would book and books nothing; the POST then books it", async () => {
    const invoice = await makeInvoice();
    await send(invoice.id);
    await createStatementWithTransactions(user.id, {
      periodMonth: "2025-03",
      transactions: [{ date: "2025-03-20", amountCents: 125_50, counterparty: "Anna Asiakas" }],
    });
    await prisma.transaction.updateMany({ data: { reference: invoice.reference } });

    const preview = await readJson(
      await previewMatch(buildRequest("GET", "/api/invoices/match", undefined, { cookie }))
    );
    expect(preview.preview).toEqual([
      expect.objectContaining({
        invoiceId: invoice.id,
        invoiceNumber: invoice.number,
        customerName: "Anna Asiakas",
        amount: 125.5,
        paidDate: "2025-03-20",
      }),
    ]);
    expect(preview.applied).toEqual([]);
    expect(await prisma.invoicePayment.count()).toBe(0);

    const run = await readJson(
      await runMatch(buildRequest("POST", "/api/invoices/match", undefined, { cookie }))
    );
    expect(run.applied).toHaveLength(1);
    expect(await prisma.invoicePayment.count()).toBe(1);
  });
});

describe("GET /api/recurring-invoices/run (preview)", () => {
  it("lists the due invoices with recipient and send mode, and creates nothing", async () => {
    const created = await createRecurring(
      buildRequest(
        "POST",
        "/api/recurring-invoices",
        {
          customerId,
          interval: "monthly",
          anchorDay: 1,
          startDate: "2020-01-01",
          endDate: "2020-02-15",
          autoSend: true,
          lines: [{ description: "Ylläpito", quantity: 1, unitPrice: 100, vatRate: 25.5 }],
        },
        { cookie }
      )
    );
    expect(created.status).toBe(201);

    const body = await readJson(
      await previewRun(buildRequest("GET", "/api/recurring-invoices/run", undefined, { cookie }))
    );
    expect(body.plan).toHaveLength(1);
    expect(body.plan[0]).toMatchObject({
      customerName: "Anna Asiakas",
      customerEmail: "anna@example.fi",
      autoSend: true,
      grossByDate: [125.5, 125.5],
      issueDates: ["2020-01-01", "2020-02-01"],
    });
    expect(await prisma.salesInvoice.count()).toBe(0);
    expect(await prisma.recurringInvoiceRun.count()).toBe(0);
  });
});

describe("exports follow the chosen period", () => {
  it("limits a CSV to ?year= and names the file by it", async () => {
    const inYear = await makeInvoice("2025-03-10");
    await makeInvoice("2024-12-31");
    const response = await exportCsv(
      buildRequest("GET", "/api/export?type=invoices&year=2025", undefined, { cookie })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toContain("myyntilaskut-2025.csv");
    const text = await response.text();
    expect(text.trim().split("\n")).toHaveLength(2); // header + the 2025 invoice
    expect(text).toContain(String(inYear.number));
  });

  it("exports the tuloslaskelma with the sales invoices in it", async () => {
    const invoice = await makeInvoice("2025-03-10", 100);
    await send(invoice.id);
    await createReceipt(user.id, { type: "meno", date: "2025-03-05", totalAmountCents: 62_75, vatDetails: JSON.stringify([{ rate: 25.5, amount: 12.75 }]) });
    const response = await exportCsv(
      buildRequest("GET", "/api/export?type=profit-loss&year=2025", undefined, { cookie })
    );
    const text = await response.text();
    expect(response.headers.get("Content-Disposition")).toContain("tuloslaskelma-2025.csv");
    const march = text.split("\n").find((line) => line.startsWith("2025-03"));
    expect(march).toBeDefined();
    expect(march).toContain("100,00");
  });

  it("builds a quarter package from the statements of all three months", async () => {
    await createStatementWithTransactions(user.id, {
      periodMonth: "2025-02",
      transactions: [{ date: "2025-02-10", amountCents: 1_000 }],
    });
    await createStatementWithTransactions(user.id, {
      periodMonth: "2025-04",
      transactions: [{ date: "2025-04-10", amountCents: 2_000 }],
    });
    const response = await exportPackage(
      buildRequest("GET", "/api/export/package?month=2025-Q1", undefined, { cookie })
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Disposition")).toContain("kirjanpito-2025-Q1.zip");
    const files = readStoredZip(Buffer.from(await response.arrayBuffer()));
    const csv = files.get("csv/tilitapahtumat.csv")?.toString("utf8") ?? "";
    expect(csv).toContain("2025-02-10");
    expect(csv).not.toContain("2025-04-10");
  });
});
