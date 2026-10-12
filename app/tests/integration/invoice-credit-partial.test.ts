import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { POST as createCustomer } from "@/app/api/customers/route";
import { POST as createInvoice } from "@/app/api/invoices/route";
import { POST as setStatus } from "@/app/api/invoices/[id]/status/route";
import { POST as creditInvoice } from "@/app/api/invoices/[id]/credit/route";
import { loadAlvPeriodSources } from "@/lib/alv-period";
import { buildProfitLoss } from "@/lib/reports";
import { helsinkiCalendarDate } from "@/lib/validation";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;
let customerId: string;

/** 1 kpl × 100,00 € at 25,5 % → net 100,00, vat 25,50, gross 125,50. */
const LINE = { description: "Ripsienpidennys", quantity: 1, unitPrice: 100, vatRate: 25.5 };

async function makeInvoice(overrides: Record<string, unknown> = {}) {
  const today = helsinkiCalendarDate();
  const response = await createInvoice(
    buildRequest(
      "POST",
      "/api/invoices",
      { customerId, issueDate: today, dueDate: today, lines: [LINE], ...overrides },
      { cookie }
    )
  );
  expect(response.status).toBe(201);
  return (await readJson(response)).invoice;
}

async function send(id: string) {
  const response = await setStatus(
    buildRequest("POST", `/api/invoices/${id}/status`, { status: "sent" }, { cookie }),
    routeContext({ id })
  );
  expect(response.status).toBe(200);
  return (await readJson(response)).invoice;
}

/** The credit route as the app calls it: no body = full remaining credit. */
async function credit(id: string, body?: unknown, headers?: Record<string, string>) {
  return creditInvoice(
    buildRequest("POST", `/api/invoices/${id}/credit`, body, { cookie, headers }),
    routeContext({ id })
  );
}

/** The current month's booked sales income, exactly as the P&L reads it. */
async function monthIncomeCents(): Promise<number> {
  const today = helsinkiCalendarDate();
  const [year, month] = today.split("-").map(Number);
  const sources = await loadAlvPeriodSources(
    user.id,
    new Date(Date.UTC(year, month - 1, 1)),
    new Date(Date.UTC(year, month, 1))
  );
  return buildProfitLoss(sources.reportReceipts, sources.reportInvoices).total.incomeGrossCents;
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

describe("partial credit notes (W5)", () => {
  it("credits 40 % of a line and drops that month's sales by exactly that", async () => {
    const invoice = await send((await makeInvoice()).id);
    expect(await monthIncomeCents()).toBe(12550);

    const response = await credit(invoice.id, { lines: [{ lineId: invoice.lines[0].id, quantity: 0.4 }] });
    expect(response.status).toBe(201);
    const note = (await readJson(response)).invoice;
    expect(note.documentKind).toBe("credit_note");
    // Gapless numbering: the credit is the very next number in the series.
    expect(note.number).toBe(invoice.number + 1);
    // The reversal: 40,00 net + 10,20 vat, stored negative.
    expect(note.net).toBeCloseTo(-40);
    expect(note.vat).toBeCloseTo(-10.2);
    expect(note.gross).toBeCloseTo(-50.2);
    expect(note.lines[0].quantity).toBe(0.4);
    expect(note.creditsInvoice.number).toBe(invoice.number);

    const stored = await prisma.salesInvoice.findUnique({
      where: { id: invoice.id },
      select: { status: true },
    });
    // Only partly credited: the rest is still owed and can still be credited.
    expect(stored?.status).toBe("sent");
    expect(await monthIncomeCents()).toBe(12550 - 5020);
  });

  it("refuses a credit larger than the creditable remainder, then lets the rest through", async () => {
    const invoice = await send((await makeInvoice()).id);
    await credit(invoice.id, { lines: [{ lineId: invoice.lines[0].id, quantity: 0.4 }] });

    const tooMuch = await credit(invoice.id, { lines: [{ lineId: invoice.lines[0].id, quantity: 0.7 }] });
    expect(tooMuch.status).toBe(400);
    const tooMuchBody = await readJson(tooMuch);
    expect(tooMuchBody.error.message).toContain("hyvitettävissä enää 0,6");

    // The remaining 0,6 is still creditable, and that finishes the invoice.
    const rest = await credit(invoice.id, { lines: [{ lineId: invoice.lines[0].id, quantity: 0.6 }] });
    expect(rest.status).toBe(201);
    expect((await readJson(rest)).invoice.gross).toBeCloseTo(-75.3);

    const original = await prisma.salesInvoice.findUnique({
      where: { id: invoice.id },
      select: { status: true },
    });
    expect(original?.status).toBe("credited");
    const done = await credit(invoice.id);
    expect(done.status).toBe(409);
  });

  it("still credits the whole remaining amount with no body (the original path)", async () => {
    const invoice = await send((await makeInvoice()).id);
    const response = await credit(invoice.id);
    expect(response.status).toBe(201);
    const note = (await readJson(response)).invoice;
    expect(note.gross).toBeCloseTo(-125.5);
    expect(note.lines[0].quantity).toBe(1);
    const original = await prisma.salesInvoice.findUnique({
      where: { id: invoice.id },
      select: { status: true },
    });
    expect(original?.status).toBe("credited");
    expect(await monthIncomeCents()).toBe(0);
  });

  it("answers a retried tap with the first note, not a second credit", async () => {
    const invoice = await send((await makeInvoice()).id);
    const body = { lines: [{ lineId: invoice.lines[0].id, quantity: 0.4 }] };
    const headers = { "idempotency-key": "w5-credit-retry" };
    const first = await credit(invoice.id, body, headers);
    const second = await credit(invoice.id, body, headers);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const firstNote = (await readJson(first)).invoice;
    const secondNote = (await readJson(second)).invoice;
    expect(secondNote.id).toBe(firstNote.id);
    const count = await prisma.salesInvoice.count({
      where: { userId: user.id, documentKind: "credit_note" },
    });
    expect(count).toBe(1);
  });

  it("refuses a line that does not belong to the invoice", async () => {
    const invoice = await send((await makeInvoice()).id);
    const stranger = await send((await makeInvoice()).id);
    const response = await credit(invoice.id, {
      lines: [{ lineId: stranger.lines[0].id, quantity: 1 }],
    });
    expect(response.status).toBe(400);
    const count = await prisma.salesInvoice.count({
      where: { userId: user.id, documentKind: "credit_note" },
    });
    expect(count).toBe(0);
  });
});
