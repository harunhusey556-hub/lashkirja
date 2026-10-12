import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as uploadReceipt } from "@/app/api/receipts/route";
import { POST as saveReceipt } from "@/app/api/receipts/save/route";
import { prisma } from "@/lib/db";
import { processDocumentJob, setDocumentExtractorForTests } from "@/lib/document-jobs";
import { createPurchaseInvoice } from "@/lib/purchase-invoices";
import type { ExtractedReceipt } from "@/lib/ai";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildFormRequest, buildRequest, readJson, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;

const usdInvoice: ExtractedReceipt = {
  vendor: "Acme US",
  date: "2026-02-02",
  totalAmount: null, // no euro figure printed: the app must not invent one
  originalAmount: 50.1,
  vatDetails: [{ rate: 0, amount: 0 }],
  category: "ohjelmistot",
  notes: null,
  type: "meno",
  reference: null,
  invoiceNumber: "INV-77",
  source: "ai",
  provenance: "openai-compatible",
  confidence: 0.6,
  documentType: "invoice",
  currency: "USD",
  sellerCountry: "US",
  dueDate: "2026-03-02",
};

function jpeg(extra = 0): File {
  return new File([Uint8Array.from([0xff, 0xd8, 0xff, extra, 0xd9])], "kuitti.jpg", {
    type: "image/jpeg",
  });
}

async function postFile(file: File) {
  const form = new FormData();
  form.set("file", file);
  return uploadReceipt(buildFormRequest("/api/receipts", form, { cookie }));
}

async function finish(jobId: string) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await processDocumentJob(jobId);
    const job = await prisma.backgroundJob.findUnique({ where: { id: jobId } });
    if (job?.status === "done" || job?.status === "failed") return job;
  }
  throw new Error("job did not finish");
}

async function uploadAndSave(extraction: ExtractedReceipt, body: Record<string, unknown>) {
  setDocumentExtractorForTests(async () => extraction);
  const uploaded = await postFile(jpeg());
  expect(uploaded.status).toBe(200);
  const uploadBody = await readJson<{ jobId: string; uploadId: string }>(uploaded);
  const job = await finish(uploadBody.jobId);
  expect(job?.status).toBe("done");
  return saveReceipt(
    buildRequest("POST", "/api/receipts/save", { uploadId: uploadBody.uploadId, ...body }, { cookie })
  );
}

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

afterEach(() => {
  setDocumentExtractorForTests(null);
});

describe("a foreign-currency bill", () => {
  it("keeps its currency and original amount through save, and becomes an ostolasku", async () => {
    // The owner reviews the reading and types only the euro figure; the
    // currency, the original amount and the VAT treatment come from the reading.
    const saved = await uploadAndSave(usdInvoice, {
      vendor: "Acme US",
      date: "2026-02-02",
      totalAmount: 48.5,
      category: "ohjelmistot",
      type: "meno",
      vatDetails: [{ rate: 0, amount: 0 }],
      invoiceNumber: "INV-77",
    });
    expect(saved.status).toBe(200);
    const body = await readJson(saved);
    expect(body.receipt.currency).toBe("USD");
    expect(body.receipt.originalAmount).toBe(50.1);
    expect(body.receipt.totalAmount).toBe(48.5);
    expect(body.receipt.vatTreatment).toBe("non_eu_service");

    const invoice = body.purchaseInvoice;
    expect(invoice).toBeTruthy();
    expect(invoice.supplierName).toBe("Acme US");
    expect(invoice.invoiceNumber).toBe("INV-77");
    expect(invoice.issueDate).toBe("2026-02-02");
    expect(invoice.dueDate).toBe("2026-03-02");
    expect(invoice.gross).toBe(48.5);
    expect(invoice.vat).toBe(0);
    expect(invoice.currency).toBe("USD");
    expect(invoice.originalAmount).toBe(50.1);
    expect(invoice.vatTreatment).toBe("non_eu_service");
    expect(invoice.receiptId).toBe(body.receipt.id);
    expect(body.purchaseInvoiceSkipped).toBeNull();

    const stored = await prisma.purchaseInvoice.findUnique({ where: { id: invoice.id } });
    expect(stored).toMatchObject({
      userId: user.id,
      grossCents: 4850,
      originalAmountCents: 5010,
      currency: "USD",
    });
  });

  it("takes the owner's own figure when they typed one", async () => {
    const saved = await uploadAndSave(usdInvoice, {
      vendor: "Acme US",
      date: "2026-02-02",
      totalAmount: 48.5,
      currency: "USD",
      originalAmount: 51,
      vatTreatment: "non_eu_goods",
      category: "ohjelmistot",
      type: "meno",
      vatDetails: [{ rate: 0, amount: 0 }],
      invoiceNumber: "INV-77",
    });
    const body = await readJson(saved);
    expect(body.receipt.originalAmount).toBe(51);
    expect(body.receipt.vatTreatment).toBe("non_eu_goods");
    expect(body.purchaseInvoice.originalAmount).toBe(51);
  });

  it("falls back to the issue date when the bill did not name a due date", async () => {
    const saved = await uploadAndSave({ ...usdInvoice, dueDate: null }, {
      vendor: "Acme US",
      date: "2026-02-02",
      totalAmount: 48.5,
      category: "ohjelmistot",
      type: "meno",
      vatDetails: [{ rate: 0, amount: 0 }],
      invoiceNumber: "INV-77",
    });
    const body = await readJson(saved);
    expect(body.purchaseInvoice.dueDate).toBe("2026-02-02");
  });
});

describe("a bill the AI read as a kuitti or as not-a-bill", () => {
  it("is filed as a receipt only, never as an ostolasku", async () => {
    const saved = await uploadAndSave(
      { ...usdInvoice, documentType: "receipt", currency: "USD" },
      {
        vendor: "Acme US",
        date: "2026-02-02",
        totalAmount: 48.5,
        category: "ohjelmistot",
        type: "meno",
        vatDetails: [{ rate: 0, amount: 0 }],
        invoiceNumber: "INV-77",
      }
    );
    const body = await readJson(saved);
    expect(body.purchaseInvoice).toBeNull();
    expect(body.purchaseInvoiceSkipped).toBe("not_an_invoice");
    expect(await prisma.purchaseInvoice.count()).toBe(0);
  });

  it("files nothing for a marketing document", async () => {
    const saved = await uploadAndSave(
      { ...usdInvoice, documentType: "marketing", dueDate: null },
      {
        vendor: "Acme US",
        date: "2026-02-02",
        totalAmount: 48.5,
        category: "ohjelmistot",
        type: "meno",
        vatDetails: [{ rate: 0, amount: 0 }],
        invoiceNumber: "INV-77",
      }
    );
    const body = await readJson(saved);
    expect(body.purchaseInvoice).toBeNull();
    expect(await prisma.purchaseInvoice.count()).toBe(0);
  });
});

describe("a bill whose ostolasku already exists", () => {
  it("saves the receipt but never a second invoice for the same supplier number", async () => {
    await createPurchaseInvoice(user.id, {
      supplierName: "Acme US",
      invoiceNumber: "INV-77",
      issueDate: "2026-02-02",
      dueDate: "2026-03-02",
      gross: 48.5,
    });
    const saved = await uploadAndSave(usdInvoice, {
      vendor: "Acme US",
      date: "2026-02-02",
      totalAmount: 48.5,
      category: "ohjelmistot",
      type: "meno",
      vatDetails: [{ rate: 0, amount: 0 }],
      invoiceNumber: "INV-77",
    });
    const body = await readJson(saved);
    expect(saved.status).toBe(200);
    expect(body.purchaseInvoice).toBeNull();
    expect(body.purchaseInvoiceSkipped).toBe("duplicate");
    expect(await prisma.purchaseInvoice.count()).toBe(1);
  });
});

describe("a domestic bill whose printed VAT is not a whole euro", () => {
  it("files the ostolasku with the VAT the document shows instead of answering 500", async () => {
    // Regression (2026-10-12 test group): the VAT total of the receipt was summed in euros
    // and then passed through centsToEuros(), which demands integer cents. Any bill whose
    // VAT total was not a whole euro made the save route throw RangeError after the receipt
    // had already been written: the owner saw a 500 and no ostolasku was filed.
    const bill: ExtractedReceipt = {
      ...usdInvoice,
      vendor: "Kampaamotukku Oy",
      date: "2026-02-10",
      totalAmount: 100.5,
      originalAmount: null,
      vatDetails: [{ rate: 25.5, amount: 20.42 }],
      category: "tarvikkeet",
      invoiceNumber: "1234",
      documentType: "invoice",
      currency: "EUR",
      sellerCountry: "FI",
      dueDate: "2026-03-12",
    };
    const saved = await uploadAndSave(bill, {
      vendor: "Kampaamotukku Oy",
      date: "2026-02-10",
      totalAmount: 100.5,
      category: "tarvikkeet",
      type: "meno",
      vatDetails: [{ rate: 25.5, amount: 20.42 }],
      invoiceNumber: "1234",
    });
    expect(saved.status).toBe(200);
    const body = await readJson(saved);
    expect(body.purchaseInvoice).toBeTruthy();
    expect(body.purchaseInvoice.gross).toBe(100.5);
    expect(body.purchaseInvoice.vat).toBe(20.42);
    expect(body.purchaseInvoice.net).toBe(80.08);
    expect(await prisma.purchaseInvoice.count()).toBe(1);
  });
});
