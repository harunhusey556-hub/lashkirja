import { beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { POST as createPurchase } from "@/app/api/purchase-invoices/route";
import { POST as addPurchasePayment } from "@/app/api/purchase-invoices/[id]/payments/route";
import { failNextIdempotencyResponseForTests } from "@/lib/idempotency";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;

const BASE = {
  supplierName: "Tukku Oy",
  issueDate: "2026-01-10",
  dueDate: "2026-01-24",
  gross: 124,
  vat: 24,
};

beforeEach(async () => {
  await resetDatabase();
  failNextIdempotencyResponseForTests(0);
  user = await createUser();
  cookie = await sessionCookie(user);
});

function create(key: string | null, body: Record<string, unknown> = BASE) {
  const headers: Record<string, string> = key ? { "idempotency-key": key } : {};
  return createPurchase(buildRequest("POST", "/api/purchase-invoices", body, { cookie, headers }));
}

function pay(invoiceId: string, key: string | null, body: Record<string, unknown> = { amount: 24, paidDate: "2026-01-20" }) {
  const headers: Record<string, string> = key ? { "idempotency-key": key } : {};
  return addPurchasePayment(
    buildRequest("POST", `/api/purchase-invoices/${invoiceId}/payments`, body, { cookie, headers }),
    routeContext({ id: invoiceId })
  );
}

const invoiceCount = () => prisma.purchaseInvoice.count({ where: { userId: user.id } });
const paymentCount = (id: string) => prisma.purchasePayment.count({ where: { purchaseInvoiceId: id } });

describe("POST /api/purchase-invoices with Idempotency-Key", () => {
  it("creates the invoice once and replays the answer on a retry", async () => {
    const first = await create("pi-1");
    expect(first.status).toBe(201);
    const firstBody = await readJson(first);

    const retry = await create("pi-1");
    expect(retry.status).toBe(201);
    expect((await readJson(retry)).invoice.id).toBe(firstBody.invoice.id);
    expect(await invoiceCount()).toBe(1);
  });

  it("refuses the same key with a different invoice", async () => {
    await create("pi-2");
    const other = await create("pi-2", { ...BASE, supplierName: "Toinen Oy" });
    expect(other.status).toBe(409);
    expect(await invoiceCount()).toBe(1);
  });

  it("rolls the invoice back when the answer cannot be stored, so the retry creates one", async () => {
    failNextIdempotencyResponseForTests(1);
    const failed = await create("pi-3");
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(await invoiceCount()).toBe(0);

    const retry = await create("pi-3");
    expect(retry.status).toBe(201);
    expect(await invoiceCount()).toBe(1);
  });

  it("still creates without a key", async () => {
    expect((await create(null)).status).toBe(201);
    expect((await create(null)).status).toBe(201);
    expect(await invoiceCount()).toBe(2);
  });
});

describe("POST /api/purchase-invoices/[id]/payments with Idempotency-Key", () => {
  it("records the payment once and replays the answer on a retry", async () => {
    const invoice = (await readJson(await create(null))).invoice;

    const first = await pay(invoice.id, "pay-1");
    expect(first.status).toBe(201);
    expect((await readJson(first)).invoice).toMatchObject({ paid: 24, open: 100 });

    const retry = await pay(invoice.id, "pay-1");
    expect(retry.status).toBe(201);
    expect((await readJson(retry)).invoice).toMatchObject({ paid: 24, open: 100 });
    expect(await paymentCount(invoice.id)).toBe(1);

    // A new key is a new payment.
    const second = await pay(invoice.id, "pay-2", { amount: 100, paidDate: "2026-01-21" });
    expect(second.status).toBe(201);
    expect((await readJson(second)).invoice).toMatchObject({ status: "paid", open: 0 });
    expect(await paymentCount(invoice.id)).toBe(2);
  });

  it("refuses the same key with a different amount", async () => {
    const invoice = (await readJson(await create(null))).invoice;
    await pay(invoice.id, "pay-3");
    const other = await pay(invoice.id, "pay-3", { amount: 50, paidDate: "2026-01-20" });
    expect(other.status).toBe(409);
    expect(await paymentCount(invoice.id)).toBe(1);
  });

  it("rolls the payment back when the answer cannot be stored", async () => {
    const invoice = (await readJson(await create(null))).invoice;
    failNextIdempotencyResponseForTests(1);
    const failed = await pay(invoice.id, "pay-4");
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(await paymentCount(invoice.id)).toBe(0);

    const retry = await pay(invoice.id, "pay-4");
    expect(retry.status).toBe(201);
    expect(await paymentCount(invoice.id)).toBe(1);
  });

  it("keeps the payment rules inside the idempotent run", async () => {
    const invoice = (await readJson(await create(null))).invoice;
    const tooMuch = await pay(invoice.id, "pay-5", { amount: 500, paidDate: "2026-01-20" });
    expect(tooMuch.status).toBe(422);
    expect(await paymentCount(invoice.id)).toBe(0);
    // The refused key is released: a corrected retry with it is recorded.
    expect(await prisma.idempotencyRecord.count({ where: { userId: user.id, key: "pay-5" } })).toBe(0);
  });
});
