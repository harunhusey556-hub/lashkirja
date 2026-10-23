import { beforeEach, describe, expect, it } from "vitest";
import { GET as getInvoice } from "@/app/api/invoices/[id]/route";
import { POST as createInvoice } from "@/app/api/invoices/route";
import { POST as creditInvoice } from "@/app/api/invoices/[id]/credit/route";
import { POST as duplicateInvoice } from "@/app/api/invoices/[id]/duplicate/route";
import { POST as setStatus } from "@/app/api/invoices/[id]/status/route";
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

async function markSent(id: string): Promise<void> {
  const response = await setStatus(
    buildRequest("POST", `/api/invoices/${id}/status`, { status: "sent" }, { cookie }),
    routeContext({ id })
  );
  expect(response.status).toBe(200);
}

async function copyOf(id: string, headers: Record<string, string> = {}): Promise<Json> {
  const response = await duplicateInvoice(
    buildRequest("POST", `/api/invoices/${id}/duplicate`, {}, { cookie, headers }),
    routeContext({ id })
  );
  expect(response.status).toBe(201);
  return readJson<Json>(response);
}

/** The two fields the app reads, beside the invoice. */
function barcodeFields(body: Json): Json {
  return { barcode: body.barcode, barcodeIssue: body.barcodeIssue };
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
    // Beside the invoice, not inside it: the app's InvoiceDetailResponse reads them from here (R5).
    expect(body.invoice).not.toHaveProperty("barcode");
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

describe("POST /api/invoices/:id/duplicate barcode", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it("answers with the barcode fields the copy's detail gives, for a sent invoice with an IBAN", async () => {
    user = await createUser();
    await prisma.user.update({ where: { id: user.id }, data: { invoiceIban: "FI2112345600000785" } });
    cookie = await sessionCookie(user);
    const sourceId = await makeInvoice();
    await markSent(sourceId);
    const source = await fetchInvoice(sourceId);
    expect(decodeBankBarcode(source.barcode)?.iban).toBe("FI2112345600000785");

    const copy = await copyOf(sourceId);
    const detail = await fetchInvoice(copy.invoice.id);
    expect(copy.barcode).toMatch(/^4\d{53}$/);
    expect(barcodeFields(copy)).toEqual(barcodeFields(detail));
  });

  it("answers with the same issue as the detail when the seller has no IBAN", async () => {
    user = await createUser();
    await prisma.user.update({ where: { id: user.id }, data: { invoiceIban: null } });
    cookie = await sessionCookie(user);
    const sourceId = await makeInvoice();
    await markSent(sourceId);

    const copy = await copyOf(sourceId);
    const detail = await fetchInvoice(copy.invoice.id);
    expect(copy.barcode).toBeNull();
    expect(copy.barcodeIssue).toContain("tilinumero");
    expect(barcodeFields(copy)).toEqual(barcodeFields(detail));
  });

  it("gives a credit note no barcode and no issue, and its copy, an ordinary invoice, the detail's", async () => {
    user = await createUser();
    await prisma.user.update({ where: { id: user.id }, data: { invoiceIban: "FI2112345600000785" } });
    cookie = await sessionCookie(user);
    const sourceId = await makeInvoice();
    await markSent(sourceId);
    const credit = await creditInvoice(
      buildRequest("POST", `/api/invoices/${sourceId}/credit`, {}, { cookie }),
      routeContext({ id: sourceId })
    );
    expect(credit.status).toBe(201);
    const noteId = (await readJson<Json>(credit)).invoice.id;

    const note = await fetchInvoice(noteId);
    expect(note.invoice.documentKind).toBe("credit_note");
    expect(barcodeFields(note)).toEqual({ barcode: null, barcodeIssue: null });

    const copy = await copyOf(noteId);
    const detail = await fetchInvoice(copy.invoice.id);
    expect(copy.invoice.documentKind).toBe("invoice");
    expect(copy.barcode).toMatch(/^4\d{53}$/);
    expect(barcodeFields(copy)).toEqual(barcodeFields(detail));
  });

  it("gives a retry of the same tap the first copy and a barcode again", async () => {
    user = await createUser();
    await prisma.user.update({ where: { id: user.id }, data: { invoiceIban: "FI2112345600000785" } });
    cookie = await sessionCookie(user);
    const sourceId = await makeInvoice();
    await markSent(sourceId);

    const first = await copyOf(sourceId, { "idempotency-key": "barcode-copy-1" });
    const again = await copyOf(sourceId, { "idempotency-key": "barcode-copy-1" });
    expect(again.invoice.id).toBe(first.invoice.id);
    expect(again.barcode).toMatch(/^4\d{53}$/);
    expect(barcodeFields(again)).toEqual(barcodeFields(first));
  });
});
