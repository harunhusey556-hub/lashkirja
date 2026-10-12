import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { GET as listPurchases, POST as createPurchase } from "@/app/api/purchase-invoices/route";
import { POST as creditPurchase } from "@/app/api/purchase-invoices/[id]/credit/route";
import { POST as addPurchasePayment } from "@/app/api/purchase-invoices/[id]/payments/route";
import { DELETE as deletePurchase, PATCH as patchPurchase } from "@/app/api/purchase-invoices/[id]/route";
import { GET as purchaseCounts } from "@/app/api/purchase-invoices/counts/route";
import { GET as alv } from "@/app/api/alv/route";
import { loadLedger } from "@/lib/ledger/load";
import { fileReceiptAsPurchaseInvoice, isCreditNoteExtraction } from "@/lib/purchase-invoices";
import { createReceipt, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

/**
 * W11: a supplier's credit note (hyvityslasku) against an ostolasku. A row with a
 * negative total, linked to the invoice it corrects; the invoice keeps its
 * figures and owes gross - paid - credited.
 */

let user: TestUser;
let cookie: string;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const PERIOD = "2026-08";
const BASE = {
  supplierName: "Tukku Oy",
  invoiceNumber: "A-100",
  issueDate: `${PERIOD}-10`,
  dueDate: `${PERIOD}-24`,
  gross: 124,
  vat: 24,
  category: "tarvikkeet",
};

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

async function makeInvoice(overrides: Record<string, unknown> = {}): Promise<Json> {
  const response = await createPurchase(
    buildRequest("POST", "/api/purchase-invoices", { ...BASE, ...overrides }, { cookie })
  );
  expect(response.status).toBe(201);
  return (await readJson(response)).invoice;
}

function credit(id: string, body: Record<string, unknown> = {}, key: string | null = null) {
  const headers: Record<string, string> = key ? { "idempotency-key": key } : {};
  return creditPurchase(
    buildRequest(
      "POST",
      `/api/purchase-invoices/${id}/credit`,
      { date: `${PERIOD}-15`, reason: "Palautettu tavara", ...body },
      { cookie, headers }
    ),
    routeContext({ id })
  );
}

async function fetchInvoice(id: string): Promise<Json> {
  const response = await listPurchases(buildRequest("GET", "/api/purchase-invoices", undefined, { cookie }));
  const found = ((await readJson(response)).invoices as Json[]).find((invoice) => invoice.id === id);
  expect(found).toBeDefined();
  return found as Json;
}

async function alvOf(period = PERIOD): Promise<Json> {
  const response = await alv(buildRequest("GET", `/api/alv?period=${period}`, undefined, { cookie }));
  expect(response.status).toBe(200);
  return readJson(response);
}

describe("POST /api/purchase-invoices/[id]/credit", () => {
  it("credits the whole invoice: a negative row, the original credited with nothing open", async () => {
    const original = await makeInvoice();
    const response = await credit(original.id);
    expect(response.status).toBe(201);
    const body = await readJson(response);

    expect(body.creditNote).toMatchObject({
      gross: -124,
      vat: -24,
      net: -100,
      isCreditNote: true,
      creditsInvoiceId: original.id,
      displayStatus: "credited",
      open: 0,
      supplierName: "Tukku Oy",
    });
    expect(body.invoice).toMatchObject({ status: "credited", credited: 124, open: 0, gross: 124 });
    expect(body.invoice.creditNotes).toHaveLength(1);

    // The original's own figures are untouched: the books keep both documents.
    const stored = await prisma.purchaseInvoice.findUniqueOrThrow({ where: { id: original.id } });
    expect(stored.grossCents).toBe(12_400);
    expect(stored.status).toBe("credited");
  });

  it("credits a part: the invoice stays open for the rest, then the last credit takes the rest of the VAT", async () => {
    const original = await makeInvoice();

    const first = await readJson(await credit(original.id, { amount: 40 }));
    expect(first.creditNote.gross).toBe(-40);
    // 24,00 € of VAT pro rata to 40 of 124 → 7,74 €
    expect(first.creditNote.vat).toBe(-7.74);
    expect(first.invoice).toMatchObject({ status: "open", credited: 40, open: 84 });

    const second = await readJson(await credit(original.id, { amount: 84 }));
    expect(second.creditNote.gross).toBe(-84);
    // the credits add up to the invoice's VAT to the cent
    expect(second.creditNote.vat).toBe(-16.26);
    expect(second.invoice).toMatchObject({ status: "credited", credited: 124, open: 0 });
  });

  it("refuses a credit above what is left, with a Finnish message, and writes nothing", async () => {
    const original = await makeInvoice();
    await credit(original.id, { amount: 100 });

    const response = await credit(original.id, { amount: 30 });
    expect(response.status).toBe(409);
    const body = await readJson(response);
    expect(body.error.code).toBe("CREDIT_EXCEEDS_REMAINING");
    expect(body.error.message).toMatch(/ylittää hyvitettävissä olevan summan 24,00/);
    expect(await prisma.purchaseInvoice.count({ where: { creditsInvoiceId: original.id } })).toBe(1);
  });

  it("refuses a credit of a fully credited invoice, a credit note, and a cancelled invoice", async () => {
    const original = await makeInvoice();
    const first = await readJson(await credit(original.id));
    expect((await credit(original.id)).status).toBe(409);
    expect((await credit(first.creditNote.id)).status).toBe(409);

    const other = await makeInvoice({ invoiceNumber: "A-101" });
    await patchPurchase(
      buildRequest("PATCH", `/api/purchase-invoices/${other.id}`, { status: "cancelled" }, { cookie }),
      routeContext({ id: other.id })
    );
    expect((await credit(other.id)).status).toBe(409);
  });

  it("asks for a reason and a positive amount", async () => {
    const original = await makeInvoice();
    expect((await credit(original.id, { reason: "x" })).status).toBe(400);
    expect((await credit(original.id, { amount: 0 })).status).toBe(400);
    expect(await prisma.purchaseInvoice.count({ where: { creditsInvoiceId: original.id } })).toBe(0);
  });

  it("is idempotent: the same key twice is one credit note", async () => {
    const original = await makeInvoice();
    const first = await credit(original.id, { amount: 50 }, "credit-1");
    const firstBody = await readJson(first);
    const retry = await credit(original.id, { amount: 50 }, "credit-1");
    expect(retry.status).toBe(201);
    expect((await readJson(retry)).creditNote.id).toBe(firstBody.creditNote.id);
    expect(await prisma.purchaseInvoice.count({ where: { creditsInvoiceId: original.id } })).toBe(1);
  });

  it("settles an invoice that payments plus the credit cover, and reopens it when the credit goes", async () => {
    const original = await makeInvoice();
    await addPurchasePayment(
      buildRequest("POST", `/api/purchase-invoices/${original.id}/payments`, { amount: 84, paidDate: `${PERIOD}-20` }, { cookie }),
      routeContext({ id: original.id })
    );
    const body = await readJson(await credit(original.id, { amount: 40 }));
    expect(body.invoice).toMatchObject({ status: "paid", open: 0, credited: 40, paid: 84 });

    // The credit note goes: the 40 € is owed again.
    const removed = await deletePurchase(
      buildRequest("DELETE", `/api/purchase-invoices/${body.creditNote.id}`, undefined, { cookie }),
      routeContext({ id: body.creditNote.id })
    );
    expect(removed.status).toBe(200);
    expect(await fetchInvoice(original.id)).toMatchObject({ status: "open", open: 40, credited: 0 });
  });

  it("a payment may cover only what is left after the credit", async () => {
    const original = await makeInvoice();
    await credit(original.id, { amount: 40 });
    const pay = (amount: number) =>
      addPurchasePayment(
        buildRequest("POST", `/api/purchase-invoices/${original.id}/payments`, { amount, paidDate: `${PERIOD}-20` }, { cookie }),
        routeContext({ id: original.id })
      );
    expect((await pay(100)).status).toBe(422);
    const paid = await pay(84);
    expect(paid.status).toBe(201);
    expect((await readJson(paid)).invoice).toMatchObject({ status: "paid", open: 0 });
  });

  it("refuses a payment on a credit note, deleting an invoice that has one, and editing a credit note's amount", async () => {
    const original = await makeInvoice();
    const { creditNote } = await readJson(await credit(original.id, { amount: 40 }));

    const pay = await addPurchasePayment(
      buildRequest("POST", `/api/purchase-invoices/${creditNote.id}/payments`, { amount: 10, paidDate: `${PERIOD}-20` }, { cookie }),
      routeContext({ id: creditNote.id })
    );
    expect(pay.status).toBe(409);

    const del = await deletePurchase(
      buildRequest("DELETE", `/api/purchase-invoices/${original.id}`, undefined, { cookie }),
      routeContext({ id: original.id })
    );
    expect(del.status).toBe(409);

    const edit = await patchPurchase(
      buildRequest("PATCH", `/api/purchase-invoices/${creditNote.id}`, { gross: 99 }, { cookie }),
      routeContext({ id: creditNote.id })
    );
    expect(edit.status).toBe(409);
  });

  it("cancelling a credit note gives the amount back to the invoice", async () => {
    const original = await makeInvoice();
    const { creditNote } = await readJson(await credit(original.id));
    expect((await fetchInvoice(original.id)).status).toBe("credited");

    const cancelled = await patchPurchase(
      buildRequest("PATCH", `/api/purchase-invoices/${creditNote.id}`, { status: "cancelled" }, { cookie }),
      routeContext({ id: creditNote.id })
    );
    expect(cancelled.status).toBe(200);
    expect(await fetchInvoice(original.id)).toMatchObject({ status: "open", open: 124, credited: 0 });
  });

  it("lists a credit note under Hyvitetyt, never under Maksetut or as a payable", async () => {
    const original = await makeInvoice();
    await credit(original.id, { amount: 40 });

    const counts = (await readJson(await purchaseCounts(buildRequest("GET", "/api/purchase-invoices/counts", undefined, { cookie })))).counts;
    // The August invoice is long past due: it counts as overdue, not open.
    expect(counts).toMatchObject({ open: 0, overdue: 1, paid: 0, credited: 1 });

    const credited = await listPurchases(buildRequest("GET", "/api/purchase-invoices?status=credited", undefined, { cookie }));
    const rows = (await readJson(credited)).invoices as Json[];
    expect(rows).toHaveLength(1);
    expect(rows[0].isCreditNote).toBe(true);

    // 84 open, not 124: the aging total follows the reduced amount.
    const all = await readJson(await listPurchases(buildRequest("GET", "/api/purchase-invoices", undefined, { cookie })));
    expect(all.aging.totalOpen).toBe(84);
  });
});

describe("a credit note in the books", () => {
  it("posts the mirror of the invoice with negative signs", async () => {
    const original = await makeInvoice();
    const { creditNote } = await readJson(await credit(original.id));

    const entries = await loadLedger(user.id, new Date("2026-12-31T00:00:00.000Z"));
    const base = entries.find((entry) => entry.sourceId === original.id);
    const mirror = entries.find((entry) => entry.sourceId === creditNote.id);
    expect(base && mirror).toBeTruthy();
    for (const line of base!.lines) {
      const other = mirror!.lines.find((candidate) => candidate.account === line.account);
      expect(other).toMatchObject({ debitCents: line.creditCents, creditCents: line.debitCents });
    }
    expect(mirror!.lines).toHaveLength(base!.lines.length);

    // Together they cancel: every account nets to zero.
    const net = new Map<string, number>();
    for (const line of [...base!.lines, ...mirror!.lines]) {
      net.set(line.account, (net.get(line.account) ?? 0) + line.debitCents - line.creditCents);
    }
    expect([...net.values()].every((cents) => cents === 0)).toBe(true);
  });

  it("takes the credit's VAT off the deductible VAT of its period", async () => {
    const original = await makeInvoice();
    const before = await alvOf();
    expect(before.field307.amount).toBe(24);

    await credit(original.id, { amount: 62, vat: 12 });
    const after = await alvOf();
    expect(after.field307.amount).toBe(12);

    // A credit dated in the next month counts there, negative: the original stays counted where it was.
    await credit(original.id, { amount: 62, vat: 12, date: "2026-09-05" });
    expect((await alvOf()).field307.amount).toBe(12);
    expect((await alvOf("2026-09")).sources.purchaseInvoiceCount).toBe(1);
  });
});

describe("a credit note read from a document (isCreditNoteExtraction)", () => {
  it("recognises the reading, the sign and the heading, but not a mention further down", () => {
    expect(isCreditNoteExtraction({ totalAmountCents: 5_000 }, { documentType: "invoice" })).toBe(false);
    expect(isCreditNoteExtraction({ totalAmountCents: -5_000 }, { documentType: "invoice" })).toBe(true);
    expect(isCreditNoteExtraction({ rawText: "HYVITYSLASKU 12 / Tukku Oy" }, { documentType: "invoice" })).toBe(true);
    expect(isCreditNoteExtraction({ notes: "Credit note for order 7" }, { documentType: "invoice" })).toBe(true);
    expect(isCreditNoteExtraction({ totalAmountCents: 100 }, { documentType: "credit_note" })).toBe(true);
    const deepMention = `${"Lasku ".repeat(100)} hyvityslasku annetaan palautuksista`;
    expect(isCreditNoteExtraction({ rawText: deepMention }, { documentType: "invoice" })).toBe(false);
    // A shop receipt that says so is still not a supplier credit note.
    expect(isCreditNoteExtraction({ rawText: "Hyvityslasku" }, { documentType: "receipt" })).toBe(false);
    expect(isCreditNoteExtraction({ totalAmountCents: -5_000 }, null)).toBe(false);
  });

  it("files it as a credit note, not a payable, and keeps the document out of the VAT return", async () => {
    const receipt = await createReceipt(user.id, {
      date: `${PERIOD}-12`,
      totalAmountCents: 6_200,
      vendor: "Tukku Oy",
      reviewStatus: "approved",
    });
    await prisma.receipt.update({
      where: { id: receipt.id },
      data: {
        rawText: "HYVITYSLASKU\nTukku Oy\nSumma 62,00",
        invoiceNumber: "H-7",
        vatDetails: JSON.stringify([{ rate: 24, amount: 12 }]),
      },
    });
    const fresh = await prisma.receipt.findUniqueOrThrow({ where: { id: receipt.id } });

    const filed = await fileReceiptAsPurchaseInvoice(user.id, fresh, { documentType: "invoice", dueDate: null });
    expect(filed.created).toBe(true);
    if (!filed.created) return;
    expect(filed.invoice).toMatchObject({ gross: -62, vat: -12, isCreditNote: true, receiptId: receipt.id, open: 0 });

    // Not a payable, and the receipt does not count as an expense on top of it.
    const body = await alvOf();
    expect(body.field307.amount).toBe(-12);
    expect(body.skippedPurchaseInvoiceCount).toBe(0);

    // The same credit note filed twice is refused like any duplicate number.
    const again = await fileReceiptAsPurchaseInvoice(user.id, fresh, { documentType: "invoice", dueDate: null });
    expect(again.created).toBe(false);
  });
});
