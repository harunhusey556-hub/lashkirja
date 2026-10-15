import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as uploadReceipt } from "@/app/api/receipts/route";
import { POST as saveReceipt } from "@/app/api/receipts/save/route";
import { PATCH as patchReceipt } from "@/app/api/receipts/[id]/route";
import { POST as setKind } from "@/app/api/receipts/[id]/kind/route";
import { prisma } from "@/lib/db";
import { processDocumentJob, setDocumentExtractorForTests } from "@/lib/document-jobs";
import { resetRateLimitsForTests } from "@/lib/rate-limit";
import type { ExtractedReceipt } from "@/lib/ai";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildFormRequest, buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

/**
 * "Kuitti ⇄ Ostolasku" on the upload screen (owner, 2026-10-15): one "Lisää
 * tiedosto" button, the AI decides kuitti or ostolasku, and the owner can turn
 * a wrong decision around in one tap. POST /api/receipts/[id]/kind.
 */

let user: TestUser;
let cookie: string;

const bill: ExtractedReceipt = {
  vendor: "Kampaamotukku Oy",
  date: "2026-02-10",
  totalAmount: 100.5,
  vatDetails: [{ rate: 25.5, amount: 20.42 }],
  category: "tarvikkeet",
  notes: null,
  type: "meno",
  reference: null,
  invoiceNumber: "1234",
  source: "ai",
  provenance: "openai-compatible",
  confidence: 0.9,
  documentType: "invoice",
  currency: "EUR",
  sellerCountry: "FI",
  dueDate: "2026-03-12",
};

const saveBody = {
  vendor: "Kampaamotukku Oy",
  date: "2026-02-10",
  totalAmount: 100.5,
  category: "tarvikkeet",
  type: "meno",
  vatDetails: [{ rate: 25.5, amount: 20.42 }],
  invoiceNumber: "1234",
};

let fileByte = 0;
function jpeg(): File {
  fileByte += 1;
  return new File([Uint8Array.from([0xff, 0xd8, 0xff, fileByte, 0xd9])], "lasku.jpg", { type: "image/jpeg" });
}

async function saved(extraction: ExtractedReceipt): Promise<{ receiptId: string; uploadId: string; invoiceId: string | null }> {
  setDocumentExtractorForTests(async () => extraction);
  const form = new FormData();
  form.set("file", jpeg());
  const uploaded = await readJson<{ jobId: string; uploadId: string }>(
    await uploadReceipt(buildFormRequest("/api/receipts", form, { cookie }))
  );
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await processDocumentJob(uploaded.jobId);
    const job = await prisma.backgroundJob.findUnique({ where: { id: uploaded.jobId } });
    if (job?.status === "done") break;
  }
  const response = await saveReceipt(
    buildRequest("POST", "/api/receipts/save", { uploadId: uploaded.uploadId, ...saveBody }, { cookie })
  );
  expect(response.status).toBe(200);
  const body = await readJson(response);
  return { receiptId: body.receipt.id, uploadId: uploaded.uploadId, invoiceId: body.purchaseInvoice?.id ?? null };
}

async function kind(receiptId: string, value: unknown, asCookie = cookie) {
  return setKind(
    buildRequest("POST", `/api/receipts/${receiptId}/kind`, { kind: value }, { cookie: asCookie }),
    routeContext({ id: receiptId })
  );
}

async function storedReading(uploadId: string) {
  const upload = await prisma.upload.findUniqueOrThrow({ where: { id: uploadId } });
  return JSON.parse(upload.extractedJson ?? "{}");
}

beforeEach(async () => {
  resetRateLimitsForTests();
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

afterEach(() => {
  setDocumentExtractorForTests(null);
});

describe("POST /api/receipts/[id]/kind", () => {
  it("removes the ostolasku the AI filed when the owner says kuitti, and records the choice", async () => {
    const { receiptId, uploadId, invoiceId } = await saved(bill);
    expect(invoiceId).not.toBeNull();

    const response = await kind(receiptId, "receipt");
    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({
      ok: true,
      kind: "receipt",
      purchaseInvoiceAction: "removed",
      purchaseInvoice: null,
    });
    expect(await prisma.purchaseInvoice.count()).toBe(0);
    expect(await prisma.receipt.count({ where: { id: receiptId } })).toBe(1);
    expect(await storedReading(uploadId)).toMatchObject({ documentType: "receipt", documentTypeSetBy: "owner", vendor: "Kampaamotukku Oy" });

    // An edit later must not file the removed ostolasku again from the AI's old "lasku".
    const edited = await patchReceipt(
      buildRequest("PATCH", `/api/receipts/${receiptId}`, { notes: "Kuitti" }, { cookie }),
      routeContext({ id: receiptId })
    );
    expect(edited.status).toBe(200);
    expect(await prisma.purchaseInvoice.count()).toBe(0);
  });

  it("files a kuitti the owner says is an ostolasku, with the bill's due date", async () => {
    const { receiptId, uploadId, invoiceId } = await saved({ ...bill, documentType: "receipt" });
    expect(invoiceId).toBeNull();

    const response = await kind(receiptId, "invoice");
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body).toMatchObject({
      kind: "invoice",
      purchaseInvoiceAction: "filed",
      purchaseInvoiceSkipped: null,
      purchaseInvoice: { dueDate: "2026-03-12", isCreditNote: false },
    });
    const invoice = await prisma.purchaseInvoice.findFirstOrThrow({ where: { receiptId } });
    expect(invoice.id).toBe(body.purchaseInvoice.id);
    expect(invoice.grossCents).toBe(10_050);
    expect(await storedReading(uploadId)).toMatchObject({ documentType: "invoice", documentTypeSetBy: "owner" });
  });

  it("goes both ways and back, and a repeated request changes nothing", async () => {
    const { receiptId } = await saved(bill);

    expect((await readJson(await kind(receiptId, "receipt"))).purchaseInvoiceAction).toBe("removed");
    const again = await kind(receiptId, "receipt");
    expect(again.status).toBe(200);
    expect(await readJson(again)).toMatchObject({ purchaseInvoiceAction: "none", purchaseInvoice: null });
    expect(await prisma.purchaseInvoice.count()).toBe(0);

    const filed = await readJson(await kind(receiptId, "invoice"));
    expect(filed.purchaseInvoiceAction).toBe("filed");
    const repeat = await readJson(await kind(receiptId, "invoice"));
    expect(repeat).toMatchObject({ purchaseInvoiceAction: "none", purchaseInvoice: { id: filed.purchaseInvoice.id } });
    expect(await prisma.purchaseInvoice.count()).toBe(1);
  });

  it("answers 404 for another owner's receipt and leaves it as it was", async () => {
    const { receiptId, uploadId } = await saved(bill);
    const other = await createUser({ email: "toinen@example.com" });
    const response = await kind(receiptId, "receipt", await sessionCookie(other));
    expect(response.status).toBe(404);
    expect(await prisma.purchaseInvoice.count()).toBe(1);
    expect((await storedReading(uploadId)).documentTypeSetBy).toBeUndefined();
  });

  it("refuses with 409 to turn an ostolasku with a payment into a kuitti", async () => {
    const { receiptId, uploadId, invoiceId } = await saved(bill);
    await prisma.purchasePayment.create({
      data: { purchaseInvoiceId: invoiceId!, amountCents: 10_050, paidDate: new Date("2026-03-01"), source: "manual" },
    });
    const response = await kind(receiptId, "receipt");
    expect(response.status).toBe(409);
    expect((await readJson(response)).error.message).toMatch(/maksuja/);
    expect(await prisma.purchaseInvoice.findUniqueOrThrow({ where: { id: invoiceId! } })).toMatchObject({ status: "open" });
    expect((await storedReading(uploadId)).documentType).toBe("invoice");
  });

  it("respects a closed month", async () => {
    const { receiptId, invoiceId } = await saved(bill);
    await prisma.user.update({ where: { id: user.id }, data: { booksLockedThrough: "2026-02" } });
    const response = await kind(receiptId, "receipt");
    expect(response.status).toBe(409);
    expect(await prisma.purchaseInvoice.count({ where: { id: invoiceId! } })).toBe(1);
  });

  it("refuses a kind it does not know", async () => {
    const { receiptId } = await saved(bill);
    expect((await kind(receiptId, "lasku")).status).toBe(400);
  });
});
