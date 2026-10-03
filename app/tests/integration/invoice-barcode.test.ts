import { beforeEach, describe, expect, it } from "vitest";
import { GET as getInvoice } from "@/app/api/invoices/[id]/route";
import { POST as createInvoice } from "@/app/api/invoices/route";
import { decodeBankBarcode } from "@/lib/bank-barcode";
import { prisma } from "@/lib/db";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

/** The invoice screen offers the virtuaaliviivakoodi to copy, or says why there is none. */

let user: TestUser;
let cookie: string;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function makeInvoice(): Promise<string> {
  const customer = await prisma.customer.create({ data: { userId: user.id, name: "Anna Asiakas" } });
  const response = await createInvoice(
    buildRequest("POST", "/api/invoices", {
      customerId: customer.id,
      issueDate: "2026-01-15",
      lines: [{ description: "Ripsienpidennys", quantity: 1, unitPrice: 100, vatRate: 25.5 }],
    }, { cookie })
  );
  expect(response.status).toBe(201);
  return (await readJson<Json>(response)).invoice.id;
}

async function fetchInvoice(id: string): Promise<Json> {
  return readJson<Json>(await getInvoice(buildRequest("GET", `/api/invoices/${id}`, undefined, { cookie }), routeContext({ id })));
}

describe("GET /api/invoices/:id barcode", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("returns the virtuaaliviivakoodi for a Finnish IBAN", async () => {
    user = await createUser();
    await prisma.user.update({ where: { id: user.id }, data: { invoiceIban: "FI2112345600000785" } });
    cookie = await sessionCookie(user);
    const body = await fetchInvoice(await makeInvoice());
    expect(body.barcodeIssue).toBeNull();
    const decoded = decodeBankBarcode(body.barcode);
    expect(decoded?.iban).toBe("FI2112345600000785");
    expect(decoded?.amountCents).toBe(12_550);
  });

  it("says why there is none without an IBAN", async () => {
    user = await createUser();
    await prisma.user.update({ where: { id: user.id }, data: { invoiceIban: null } });
    cookie = await sessionCookie(user);
    const body = await fetchInvoice(await makeInvoice());
    expect(body.barcode).toBeNull();
    expect(body.barcodeIssue).toContain("tilinumero");
  });
});
