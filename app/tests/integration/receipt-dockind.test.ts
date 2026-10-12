import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as uploadReceipt, GET as listReceipts } from "@/app/api/receipts/route";
import { POST as saveReceipt } from "@/app/api/receipts/save/route";
import { PATCH as patchReceipt, DELETE as deleteReceipt } from "@/app/api/receipts/[id]/route";
import { PATCH as reviewReceipt } from "@/app/api/receipts/[id]/review/route";
import { GET as receiptCounts } from "@/app/api/receipts/counts/route";
import { GET as receiptPurchaseInvoice } from "@/app/api/receipts/[id]/purchase-invoice/route";
import { POST as inbox } from "@/app/api/receipts/inbox/route";
import { prisma } from "@/lib/db";
import { processDocumentJob, setDocumentExtractorForTests } from "@/lib/document-jobs";
import { fileReceiptAsPurchaseInvoice } from "@/lib/purchase-invoices";
import { storeEmailDocument } from "@/lib/mail-sync";
import { resetRateLimitsForTests } from "@/lib/rate-limit";
import type { ExtractedReceipt } from "@/lib/ai";
import { createReceipt, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildFormRequest, buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

/**
 * A lasku is an ostolasku, a kuitti is a kuitti (W9, owner problem G): every
 * intake path files a bill once, the owner can flip the kind, a missing due
 * date becomes the 14-day default, and Kuitit lists kuitit with the bills
 * under their own Laskut chip.
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

async function finish(jobId: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await processDocumentJob(jobId);
    const job = await prisma.backgroundJob.findUnique({ where: { id: jobId } });
    if (job?.status === "done" || job?.status === "failed") return job;
  }
  throw new Error("job did not finish");
}

async function uploadRead(extraction: ExtractedReceipt): Promise<string> {
  setDocumentExtractorForTests(async () => extraction);
  const form = new FormData();
  form.set("file", jpeg());
  const uploaded = await uploadReceipt(buildFormRequest("/api/receipts", form, { cookie }));
  expect(uploaded.status).toBe(200);
  const body = await readJson<{ jobId: string; uploadId: string }>(uploaded);
  expect((await finish(body.jobId))?.status).toBe("done");
  return body.uploadId;
}

async function save(uploadId: string, body: Record<string, unknown> = saveBody) {
  return saveReceipt(buildRequest("POST", "/api/receipts/save", { uploadId, ...body }, { cookie }));
}

async function patch(id: string, body: Record<string, unknown>) {
  return patchReceipt(buildRequest("PATCH", `/api/receipts/${id}`, body, { cookie }), routeContext({ id }));
}

async function listIds(query: string): Promise<string[]> {
  const response = await listReceipts(buildRequest("GET", `/api/receipts?reviewStatus=all&${query}`, undefined, { cookie }));
  const body = await readJson<{ receipts: Array<{ id: string }> }>(response);
  return body.receipts.map((receipt) => receipt.id);
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

describe("saving a bill", () => {
  it("files exactly one ostolasku, however often the filing runs", async () => {
    const uploadId = await uploadRead(bill);
    const saved = await save(uploadId);
    expect(saved.status).toBe(200);
    const body = await readJson(saved);
    expect(body.purchaseInvoice.receiptId).toBe(body.receipt.id);
    expect(await prisma.purchaseInvoice.count()).toBe(1);

    // The same upload saved again is refused, and the filing itself is idempotent.
    expect((await save(uploadId)).status).toBe(409);
    const receipt = await prisma.receipt.findUniqueOrThrow({ where: { id: body.receipt.id } });
    expect(await fileReceiptAsPurchaseInvoice(user.id, receipt, bill)).toEqual({ created: false, skipped: "already_filed" });
    expect(await prisma.purchaseInvoice.count()).toBe(1);
  });

  it("gives a bill without a printed due date the 14-day term, flagged as assumed", async () => {
    const uploadId = await uploadRead({ ...bill, dueDate: null });
    const body = await readJson(await save(uploadId));
    expect(body.purchaseInvoice.issueDate).toBe("2026-02-10");
    expect(body.purchaseInvoice.dueDate).toBe("2026-02-24");
    expect(body.purchaseInvoice.notes).toContain("oletus");

    const upload = await prisma.upload.findUniqueOrThrow({ where: { id: uploadId } });
    expect(JSON.parse(upload.extractedJson ?? "{}")).toMatchObject({ dueDate: null, dueDateAssumed: true });

    const view = await readJson(
      await receiptPurchaseInvoice(
        buildRequest("GET", `/api/receipts/${body.receipt.id}/purchase-invoice`, undefined, { cookie }),
        routeContext({ id: body.receipt.id })
      )
    );
    expect(view).toEqual({
      documentType: "invoice",
      purchaseInvoice: expect.objectContaining({ id: body.purchaseInvoice.id, dueDate: "2026-02-24", dueDateAssumed: true }),
    });
  });

  it("keeps the printed due date and no oletus flag when the bill has one", async () => {
    const uploadId = await uploadRead(bill);
    const body = await readJson(await save(uploadId));
    expect(body.purchaseInvoice.dueDate).toBe("2026-03-12");
    expect(body.purchaseInvoice.notes).toBeNull();
    const upload = await prisma.upload.findUniqueOrThrow({ where: { id: uploadId } });
    expect(JSON.parse(upload.extractedJson ?? "{}").dueDateAssumed).toBeUndefined();
  });
});

describe("the owner flips the kind (PATCH /api/receipts/[id])", () => {
  it("cancels the ostolasku on kuitti, keeps it, and reopens it on lasku", async () => {
    const body = await readJson(await save(await uploadRead(bill)));
    const receiptId = body.receipt.id as string;
    const invoiceId = body.purchaseInvoice.id as string;

    const toReceipt = await patch(receiptId, { documentType: "receipt" });
    expect(toReceipt.status).toBe(200);
    expect((await readJson(toReceipt)).purchaseInvoiceAction).toBe("cancelled");
    expect(await prisma.purchaseInvoice.findUniqueOrThrow({ where: { id: invoiceId } })).toMatchObject({
      status: "cancelled",
      closedReason: "Merkitty kuitiksi",
      receiptId,
    });
    expect(await prisma.purchaseInvoice.count()).toBe(1);

    const back = await patch(receiptId, { documentType: "invoice" });
    expect((await readJson(back)).purchaseInvoiceAction).toBe("reopened");
    expect(await prisma.purchaseInvoice.findUniqueOrThrow({ where: { id: invoiceId } })).toMatchObject({
      status: "open",
      closedReason: null,
    });
    expect(await prisma.purchaseInvoice.count()).toBe(1);
  });

  it("files a kuitti the owner marks as lasku, with the default term", async () => {
    const receipt = await createReceipt(user.id, { vendor: "Siivous Oy", date: "2026-03-01", totalAmountCents: 24_800 });
    const response = await patch(receipt.id, { documentType: "invoice" });
    expect(response.status).toBe(200);
    expect((await readJson(response)).purchaseInvoiceAction).toBe("filed");
    const invoice = await prisma.purchaseInvoice.findFirstOrThrow({ where: { receiptId: receipt.id } });
    expect(invoice.grossCents).toBe(24_800);
    expect(invoice.dueDate.toISOString().slice(0, 10)).toBe("2026-03-15");
  });

  it("refuses to turn a paid ostolasku back into a kuitti", async () => {
    const body = await readJson(await save(await uploadRead(bill)));
    await prisma.purchasePayment.create({
      data: { purchaseInvoiceId: body.purchaseInvoice.id, amountCents: 10_050, paidDate: new Date("2026-03-01"), source: "manual" },
    });
    const response = await patch(body.receipt.id, { documentType: "receipt" });
    expect(response.status).toBe(409);
    expect((await prisma.purchaseInvoice.findUniqueOrThrow({ where: { id: body.purchaseInvoice.id } })).status).toBe("open");
  });
});

describe("every intake path files", () => {
  it("the offline photo inbox turns a photographed bill into an ostolasku", async () => {
    setDocumentExtractorForTests(async () => bill);
    const form = new FormData();
    form.set("file", jpeg());
    form.set("capturedAt", new Date().toISOString());
    const response = await inbox(
      buildFormRequest("/api/receipts/inbox", form, { cookie, headers: { "idempotency-key": "inbox-bill-1" } })
    );
    expect(response.status).toBe(201);
    const { jobId, uploadId } = await readJson<{ jobId: string; uploadId: string }>(response);
    expect((await finish(jobId))?.status).toBe("done");

    const receipt = await prisma.receipt.findFirstOrThrow({ where: { userId: user.id, uploadId } });
    expect(receipt).toMatchObject({ source: "app_capture", reviewStatus: "pending" });
    const invoice = await prisma.purchaseInvoice.findFirstOrThrow({ where: { receiptId: receipt.id } });
    expect(invoice).toMatchObject({ supplierName: "Kampaamotukku Oy", invoiceNumber: "1234", grossCents: 10_050 });
  });

  it("the offline photo inbox files a photographed credit note inside its own transaction", async () => {
    // W11's credit filing runs through W9's inbox transaction: it must write
    // through that transaction, not wait on its lock.
    setDocumentExtractorForTests(async () => ({ ...bill, notes: "Hyvityslasku", invoiceNumber: "H-77" }));
    const form = new FormData();
    form.set("file", jpeg());
    form.set("capturedAt", new Date().toISOString());
    const response = await inbox(
      buildFormRequest("/api/receipts/inbox", form, { cookie, headers: { "idempotency-key": "inbox-credit-1" } })
    );
    expect(response.status).toBe(201);
    const { jobId, uploadId } = await readJson<{ jobId: string; uploadId: string }>(response);
    expect((await finish(jobId))?.status).toBe("done");
    const receipt = await prisma.receipt.findFirstOrThrow({ where: { userId: user.id, uploadId } });
    const credit = await prisma.purchaseInvoice.findFirstOrThrow({ where: { receiptId: receipt.id } });
    expect(credit).toMatchObject({ invoiceNumber: "H-77", grossCents: -10_050, status: "paid" });
  });

  it("the offline photo inbox leaves a photographed kuitti a kuitti", async () => {
    setDocumentExtractorForTests(async () => ({ ...bill, documentType: "receipt", invoiceNumber: null }));
    const form = new FormData();
    form.set("file", jpeg());
    form.set("capturedAt", new Date().toISOString());
    const response = await inbox(
      buildFormRequest("/api/receipts/inbox", form, { cookie, headers: { "idempotency-key": "inbox-kuitti-1" } })
    );
    const { jobId } = await readJson<{ jobId: string }>(response);
    await finish(jobId);
    expect(await prisma.receipt.count({ where: { userId: user.id } })).toBe(1);
    expect(await prisma.purchaseInvoice.count()).toBe(0);
  });

  it("an emailed bill becomes an ostolasku; an archived mail does not", async () => {
    const pdf = Buffer.from("%PDF-1.4 lasku");
    const isBill = await storeEmailDocument({
      userId: user.id,
      accountEmail: "laskut@example.com",
      content: pdf,
      filename: "lasku.pdf",
      ext: ".pdf",
      mimeType: "application/pdf",
      checksum: "email-bill-1",
      mailDate: new Date("2026-02-10T08:00:00.000Z"),
      extraction: bill,
    });
    expect(isBill).toBe(true);
    const receipt = await prisma.receipt.findFirstOrThrow({ where: { userId: user.id, source: "email_sync" } });
    expect(await prisma.purchaseInvoice.findFirst({ where: { receiptId: receipt.id } })).toMatchObject({
      supplierName: "Kampaamotukku Oy",
      grossCents: 10_050,
    });

    await storeEmailDocument({
      userId: user.id,
      accountEmail: "laskut@example.com",
      content: Buffer.from("%PDF-1.4 uutiskirje"),
      filename: "uutiskirje.pdf",
      ext: ".pdf",
      mimeType: "application/pdf",
      checksum: "email-marketing-1",
      mailDate: new Date("2026-02-11T08:00:00.000Z"),
      extraction: { ...bill, documentType: "marketing", invoiceNumber: null, totalAmount: null },
    });
    expect(await prisma.purchaseInvoice.count()).toBe(1);
  });
});

describe("Kuitit shows kuitit; the Laskut chip shows the bills", () => {
  it("splits the list and counts by kind, and an unkinded client still sees both", async () => {
    const billBody = await readJson(await save(await uploadRead(bill)));
    const kuitti = await createReceipt(user.id, { vendor: "K-Market" });

    expect(await listIds("kind=receipt")).toEqual([kuitti.id]);
    expect(await listIds("kind=invoice")).toEqual([billBody.receipt.id]);
    expect((await listIds("")).sort()).toEqual([kuitti.id, billBody.receipt.id].sort());

    const counts = await readJson(
      await receiptCounts(buildRequest("GET", "/api/receipts/counts?reviewStatus=all&kind=receipt", undefined, { cookie }))
    );
    expect(counts.counts).toMatchObject({ all: 1, meno: 1, laskut: 1 });

    // Marked a kuitti: back in Kuitit, gone from Laskut.
    await patch(billBody.receipt.id, { documentType: "receipt" });
    expect((await listIds("kind=receipt")).sort()).toEqual([kuitti.id, billBody.receipt.id].sort());
    expect(await listIds("kind=invoice")).toEqual([]);
  });
});

describe("a bill receipt the owner throws away", () => {
  async function emailedBill(checksum: string) {
    await storeEmailDocument({
      userId: user.id,
      accountEmail: "laskut@example.com",
      content: Buffer.from(`%PDF-1.4 ${checksum}`),
      filename: "lasku.pdf",
      ext: ".pdf",
      mimeType: "application/pdf",
      checksum,
      mailDate: new Date("2026-02-10T08:00:00.000Z"),
      extraction: bill,
    });
    const receipt = await prisma.receipt.findFirstOrThrow({ where: { userId: user.id, uploadId: { not: null }, upload: { sha256: checksum } } });
    const invoice = await prisma.purchaseInvoice.findFirstOrThrow({ where: { receiptId: receipt.id } });
    expect(invoice.status).toBe("open");
    return { receipt, invoice };
  }

  it("rejecting it cancels its ostolasku instead of leaving an open payable", async () => {
    const { receipt, invoice } = await emailedBill("reject-bill");
    const response = await reviewReceipt(
      buildRequest("PATCH", `/api/receipts/${receipt.id}/review`, { reviewStatus: "rejected" }, { cookie }),
      routeContext({ id: receipt.id })
    );
    expect(response.status).toBe(200);
    expect(await prisma.purchaseInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).toMatchObject({ status: "cancelled" });
  });

  it("deleting it cancels its ostolasku instead of leaving an open payable", async () => {
    const { receipt, invoice } = await emailedBill("delete-bill");
    const response = await deleteReceipt(
      buildRequest("DELETE", `/api/receipts/${receipt.id}`, undefined, { cookie }),
      routeContext({ id: receipt.id })
    );
    expect(response.status).toBe(200);
    expect(await prisma.receipt.findUnique({ where: { id: receipt.id } })).toBeNull();
    expect(await prisma.purchaseInvoice.findUniqueOrThrow({ where: { id: invoice.id } })).toMatchObject({ status: "cancelled" });
  });
});
