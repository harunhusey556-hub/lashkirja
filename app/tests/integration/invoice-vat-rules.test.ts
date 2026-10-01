import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { POST as createInvoice } from "@/app/api/invoices/route";
import { PATCH as patchInvoice } from "@/app/api/invoices/[id]/route";
import { GET as previewRun } from "@/app/api/recurring-invoices/run/route";
import { POST as setStatus } from "@/app/api/invoices/[id]/status/route";
import { POST as creditInvoice } from "@/app/api/invoices/[id]/credit/route";
import { POST as duplicateInvoice } from "@/app/api/invoices/[id]/duplicate/route";
import { POST as createRecurring } from "@/app/api/recurring-invoices/route";
import { PATCH as patchRecurring } from "@/app/api/recurring-invoices/[id]/route";
import { POST as createCustomer } from "@/app/api/customers/route";
import { runRecurringInvoices } from "@/lib/recurring-invoices";
import { buildInvoicePdfData } from "@/lib/sales-invoices";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;
let customerId: string;

const line = (vatRate: number) => ({
  description: "Ripsienpidennys",
  quantity: 1,
  unitPrice: 100,
  vatRate,
});

async function setRegistered(vatRegistered: boolean) {
  await prisma.user.update({ where: { id: user.id }, data: { vatRegistered } });
}

function postInvoice(body: Record<string, unknown> = {}) {
  return createInvoice(
    buildRequest(
      "POST",
      "/api/invoices",
      { customerId, issueDate: "2026-09-30", lines: [line(25.5)], ...body },
      { cookie }
    )
  );
}

async function makeInvoice(body: Record<string, unknown> = {}) {
  const response = await postInvoice(body);
  expect(response.status).toBe(201);
  return (await readJson(response)).invoice;
}

function postRecurring(body: Record<string, unknown> = {}) {
  return createRecurring(
    buildRequest(
      "POST",
      "/api/recurring-invoices",
      {
        customerId,
        interval: "monthly",
        anchorDay: 1,
        startDate: "2026-09-01",
        lines: [line(25.5)],
        ...body,
      },
      { cookie }
    )
  );
}

async function markSent(id: string) {
  const response = await setStatus(
    buildRequest("POST", `/api/invoices/${id}/status`, { status: "sent" }, { cookie }),
    routeContext({ id })
  );
  expect(response.status).toBe(200);
}

function credit(id: string) {
  return creditInvoice(
    buildRequest("POST", `/api/invoices/${id}/credit`, undefined, { cookie }),
    routeContext({ id })
  );
}

function duplicate(id: string) {
  return duplicateInvoice(
    buildRequest("POST", `/api/invoices/${id}/duplicate`, undefined, { cookie }),
    routeContext({ id })
  );
}

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
  const response = await createCustomer(
    buildRequest("POST", "/api/customers", { name: "Anna Asiakas" }, { cookie })
  );
  customerId = (await readJson(response)).customer.id;
});

describe("a seller who is not VAT registered never charges VAT (F01)", () => {
  beforeEach(async () => {
    await setRegistered(false);
  });

  it("stores 0 % on a new invoice whatever rate the client sent", async () => {
    const invoice = await makeInvoice({ lines: [line(25.5), line(10)] });
    expect(invoice.vat).toBe(0);
    expect(invoice.gross).toBe(200);
    expect(invoice.lines.map((entry: { vatRate: number }) => entry.vatRate)).toEqual([0, 0]);
  });

  it("stores 0 % when a draft is edited", async () => {
    const invoice = await makeInvoice({ lines: [line(0)] });
    const response = await patchInvoice(
      buildRequest(
        "PATCH",
        `/api/invoices/${invoice.id}`,
        { lines: [line(25.5)], expectedUpdatedAt: invoice.updatedAt },
        { cookie }
      ),
      routeContext({ id: invoice.id })
    );
    expect(response.status).toBe(200);
    const updated = (await readJson(response)).invoice;
    expect(updated.vat).toBe(0);
    expect(updated.lines[0].vatRate).toBe(0);
  });

  it("copies an old invoice that carried VAT as a 0 % draft", async () => {
    await setRegistered(true);
    const source = await makeInvoice();
    expect(source.vat).toBe(25.5);
    await setRegistered(false);

    const response = await duplicate(source.id);
    expect(response.status).toBe(201);
    const copy = (await readJson(response)).invoice;
    expect(copy.vat).toBe(0);
    expect(copy.lines[0].vatRate).toBe(0);
  });

  it("stores a recurring template at 0 % and bills it at 0 %", async () => {
    const response = await postRecurring();
    expect(response.status).toBe(201);
    const recurring = (await readJson(response)).recurring;
    expect(recurring.lines[0].vatRate).toBe(0);

    const result = await runRecurringInvoices(user.id, { now: new Date("2026-09-30T10:00:00Z") });
    expect(result.generated).toHaveLength(1);
    expect(result.generated[0].invoice.vat).toBe(0);
  });

  it("bills a template saved while registered at 0 % once the seller is not", async () => {
    await setRegistered(true);
    expect((await postRecurring()).status).toBe(201);
    await setRegistered(false);

    const result = await runRecurringInvoices(user.id, { now: new Date("2026-09-30T10:00:00Z") });
    expect(result.generated[0].invoice.vat).toBe(0);
    expect(result.generated[0].invoice.gross).toBe(100);
  });

  it("forces 0 % when a recurring template's lines are edited", async () => {
    const created = (await readJson(await postRecurring({ lines: [line(0)] }))).recurring;
    const response = await patchRecurring(
      buildRequest(
        "PATCH",
        `/api/recurring-invoices/${created.id}`,
        { lines: [line(25.5)] },
        { cookie }
      ),
      routeContext({ id: created.id })
    );
    expect(response.status).toBe(200);
    expect((await readJson(response)).recurring.lines[0].vatRate).toBe(0);
  });

  it("builds PDF data without VAT for an invoice created now", async () => {
    const invoice = await makeInvoice();
    const pdf = await buildInvoicePdfData(user.id, invoice.id);
    expect(pdf.vatCents).toBe(0);
    expect(pdf.lines.every((entry) => entry.vatRatePermille === 0)).toBe(true);
    expect(pdf.seller.vatRegistered).toBe(false);
  });
});

describe("a credit note reverses the original as it was charged (F01 ruling)", () => {
  it("keeps the VAT of a legacy invoice so the customer's account nets to zero", async () => {
    await setRegistered(true);
    const original = await makeInvoice();
    await markSent(original.id);
    await setRegistered(false);

    const response = await credit(original.id);
    expect(response.status).toBe(201);
    const note = (await readJson(response)).invoice;
    expect(note.gross).toBe(-125.5);
    expect(note.vat).toBe(-25.5);
  });

  it("is 0 % for an invoice that never had VAT", async () => {
    await setRegistered(false);
    const original = await makeInvoice();
    await markSent(original.id);
    const note = (await readJson(await credit(original.id))).invoice;
    expect(note.vat).toBe(0);
    expect(note.gross).toBe(-100);
  });
});

describe("14 % ended on 1.1.2026 (F44)", () => {
  it("rejects 14 % on an invoice dated in 2026 with a Finnish message", async () => {
    const response = await postInvoice({ issueDate: "2026-01-10", lines: [line(14)] });
    expect(response.status).toBe(400);
    expect((await readJson(response)).error.message).toContain("13,5");
    expect(await prisma.salesInvoice.count()).toBe(0);
  });

  it("accepts 13,5 % in 2026 and 14 % on an invoice dated in 2025", async () => {
    const reduced = await makeInvoice({ issueDate: "2026-01-10", lines: [line(13.5)] });
    expect(reduced.vat).toBe(13.5);
    const old = await makeInvoice({ issueDate: "2025-12-31", lines: [line(14)] });
    expect(old.vat).toBe(14);
  });

  it("rejects 14 % when a draft's date moves into 2026", async () => {
    const draft = await makeInvoice({ issueDate: "2025-12-31", lines: [line(14)] });
    const response = await patchInvoice(
      buildRequest(
        "PATCH",
        `/api/invoices/${draft.id}`,
        { issueDate: "2026-01-02", dueDate: "2026-01-16", expectedUpdatedAt: draft.updatedAt },
        { cookie }
      ),
      routeContext({ id: draft.id })
    );
    // Lines are not part of this edit, so the stored 14 % must still be checked.
    expect(response.status).toBe(400);
  });

  it("copies an old 14 % invoice as 13,5 %", async () => {
    const old = await makeInvoice({ issueDate: "2025-12-31", lines: [line(14)] });
    const response = await duplicate(old.id);
    expect(response.status).toBe(201);
    expect((await readJson(response)).invoice.lines[0].vatRate).toBe(13.5);
  });

  it("credits a 14 % invoice at 14 %", async () => {
    const old = await makeInvoice({ issueDate: "2025-12-31", lines: [line(14)] });
    await markSent(old.id);
    const response = await credit(old.id);
    expect(response.status).toBe(201);
    const note = (await readJson(response)).invoice;
    expect(note.lines[0].vatRate).toBe(14);
    expect(note.vat).toBe(-14);
  });

  it("rejects a recurring template whose first run is after 1.1.2026 at 14 %", async () => {
    const response = await postRecurring({ lines: [line(14)] });
    expect(response.status).toBe(400);
  });

  it("keeps an old 14 % template editable: its runs follow the change", async () => {
    const created = (
      await readJson(await postRecurring({ startDate: "2025-12-01", lines: [line(14)] }))
    ).recurring;
    const response = await patchRecurring(
      buildRequest(
        "PATCH",
        `/api/recurring-invoices/${created.id}`,
        { name: "Ylläpito", lines: [line(14)] },
        { cookie }
      ),
      routeContext({ id: created.id })
    );
    expect(response.status).toBe(200);
    expect((await readJson(response)).recurring.lines[0].vatRate).toBe(14);
  });

  it("bills an old 14 % template at 13,5 % from 2026", async () => {
    expect((await postRecurring({ startDate: "2025-12-01", lines: [line(14)] })).status).toBe(201);
    const result = await runRecurringInvoices(user.id, { now: new Date("2026-01-15T10:00:00Z") });
    const rates = result.generated.map((entry) => ({
      date: entry.issueDate,
      vatRate: entry.invoice.lines[0].vatRate,
    }));
    expect(rates).toEqual([
      { date: "2025-12-01", vatRate: 14 },
      { date: "2026-01-01", vatRate: 13.5 },
    ]);
  });
});

describe("a draft saved before the seller was corrected (V1, V2)", () => {
  it("refuses to send a draft that still carries VAT and sends it after a save", async () => {
    await setRegistered(true);
    const draft = await makeInvoice();
    expect(draft.vat).toBe(25.5);
    await setRegistered(false);

    const refused = await setStatus(
      buildRequest("POST", `/api/invoices/${draft.id}/status`, { status: "sent" }, { cookie }),
      routeContext({ id: draft.id })
    );
    expect(refused.status).toBe(409);
    const body = await readJson(refused);
    expect(JSON.stringify(body)).toContain("Avaa luonnos ja tallenna");
    const stored = await prisma.salesInvoice.findUnique({ where: { id: draft.id } });
    expect(stored?.status).toBe("draft");
    expect(stored?.grossCents).toBe(12_550);

    const saved = await patchInvoice(
      buildRequest(
        "PATCH",
        `/api/invoices/${draft.id}`,
        { lines: [line(25.5)], expectedUpdatedAt: draft.updatedAt },
        { cookie }
      ),
      routeContext({ id: draft.id })
    );
    expect(saved.status).toBe(200);
    await markSent(draft.id);
  });

  it("shows in the run preview what the run will bill", async () => {
    await setRegistered(true);
    expect((await postRecurring({ startDate: "2025-12-01", lines: [line(14)] })).status).toBe(201);
    await setRegistered(false);

    const response = await previewRun(
      buildRequest("GET", "/api/recurring-invoices/run", undefined, { cookie })
    );
    const plan = (await readJson(response)).plan[0];
    const result = await runRecurringInvoices(user.id, { now: new Date() });
    const billed = result.generated.map((entry) => entry.invoice.gross);
    expect(plan.grossByDate).toEqual(billed);
    expect(plan.grossByDate.every((gross: number) => gross === 100)).toBe(true);
  });
});
