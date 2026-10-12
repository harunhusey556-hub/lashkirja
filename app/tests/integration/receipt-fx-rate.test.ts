import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as uploadReceipt } from "@/app/api/receipts/route";
import { POST as saveReceipt } from "@/app/api/receipts/save/route";
import { prisma } from "@/lib/db";
import { processDocumentJob, setDocumentExtractorForTests } from "@/lib/document-jobs";
import { setFxFetcherForTests, type FxFetcher } from "@/lib/fx-rates";
import type { ExtractedReceipt } from "@/lib/ai";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildFormRequest, buildRequest, readJson, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;
let fxCalls: string[];

// 2026-07-12 is a Sunday: the ECB answers with Friday the 10th.
const usdBill: ExtractedReceipt = {
  vendor: "Acme US",
  date: "2026-07-12",
  totalAmount: null,
  originalAmount: 50.1,
  vatDetails: [{ rate: 0, amount: 0 }],
  category: "ohjelmistot",
  notes: null,
  type: "meno",
  reference: null,
  invoiceNumber: "INV-88",
  source: "ai",
  provenance: "openai-compatible",
  confidence: 0.6,
  documentType: "invoice",
  currency: "USD",
  sellerCountry: "US",
  dueDate: "2026-08-12",
};

const ecb: FxFetcher = async (url) => {
  fxCalls.push(url);
  return { ok: true, status: 200, json: async () => ({ base: "USD", date: "2026-07-10", rates: { EUR: 0.9123 } }) };
};

const offline: FxFetcher = async () => {
  throw new Error("offline");
};

function jpeg(extra = 0): File {
  return new File([Uint8Array.from([0xff, 0xd8, 0xff, extra, 0xd9])], "kuitti.jpg", { type: "image/jpeg" });
}

async function readOne(extraction: ExtractedReceipt, fileSeed = 0) {
  setDocumentExtractorForTests(async () => extraction);
  const form = new FormData();
  form.set("file", jpeg(fileSeed));
  const uploaded = await uploadReceipt(buildFormRequest("/api/receipts", form, { cookie }));
  expect(uploaded.status).toBe(200);
  const { jobId, uploadId } = await readJson<{ jobId: string; uploadId: string }>(uploaded);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await processDocumentJob(jobId);
    const job = await prisma.backgroundJob.findUnique({ where: { id: jobId } });
    if (job?.status === "done" || job?.status === "failed") break;
  }
  const upload = await prisma.upload.findUniqueOrThrow({ where: { id: uploadId } });
  return { uploadId, reading: JSON.parse(upload.extractedJson ?? "{}") as Record<string, unknown> };
}

function save(uploadId: string, body: Record<string, unknown>) {
  return saveReceipt(
    buildRequest(
      "POST",
      "/api/receipts/save",
      { uploadId, vendor: "Acme US", date: "2026-07-12", category: "ohjelmistot", type: "meno", vatDetails: [{ rate: 0, amount: 0 }], ...body },
      { cookie }
    )
  );
}

beforeEach(async () => {
  await resetDatabase();
  // The rate cache is not user data, so resetDatabase leaves it alone.
  await prisma.$executeRaw`DELETE FROM "FxRate"`;
  user = await createUser();
  cookie = await sessionCookie(user);
  fxCalls = [];
  setFxFetcherForTests(ecb);
});

afterEach(() => {
  setDocumentExtractorForTests(null);
  setFxFetcherForTests(null);
});

describe("a USD bill with no euro total printed", () => {
  it("is priced at the ECB rate when it is read, and the reading says which rate", async () => {
    const { uploadId, reading } = await readOne(usdBill);
    expect(reading).toMatchObject({
      currency: "USD",
      originalAmount: 50.1,
      totalAmount: 45.71, // 50.10 * 0.9123
      fxRate: 0.9123,
      fxRateDate: "2026-07-10",
      fxSource: "ECB",
    });
    expect(fxCalls).toEqual(["https://api.frankfurter.app/2026-07-12?from=USD&to=EUR"]);
    const cached = await prisma.$queryRaw<Array<{ currency: string; date: string; rate: number; rateDate: string; source: string }>>`
      SELECT "currency", "date", "rate", "rateDate", "source" FROM "FxRate"`;
    expect(cached).toEqual([{ currency: "USD", date: "2026-07-12", rate: 0.9123, rateDate: "2026-07-10", source: "ECB" }]);

    const saved = await save(uploadId, { totalAmount: 45.71 });
    expect(saved.status).toBe(200);
    const body = await readJson(saved);
    expect(body.receipt.totalAmount).toBe(45.71);
    expect(body.receipt.originalAmount).toBe(50.1);
    expect(body.fx).toBeNull();
  });

  it("reuses the cached rate for the next document of that day", async () => {
    await readOne(usdBill);
    await readOne({ ...usdBill, invoiceNumber: "INV-89", originalAmount: 10 }, 1);
    expect(fxCalls).toHaveLength(1);
  });

  it("stays a gap for the owner when the rate cannot be fetched", async () => {
    setFxFetcherForTests(offline);
    const { reading } = await readOne(usdBill);
    expect(reading.totalAmount).toBeNull();
    expect(reading.originalAmount).toBe(50.1);
    expect(reading.fxRate).toBeNull();
  });

  it("is priced at save time when the owner left the euro figure empty", async () => {
    setFxFetcherForTests(offline);
    const { uploadId } = await readOne(usdBill);
    setFxFetcherForTests(ecb);

    const saved = await save(uploadId, {});
    expect(saved.status).toBe(200);
    const body = await readJson(saved);
    expect(body.receipt.totalAmount).toBe(45.71);
    expect(body.fx).toMatchObject({ totalAmount: 45.71, fxRate: 0.9123, fxSource: "ECB", fxRateDate: "2026-07-10" });
    const upload = await prisma.upload.findUniqueOrThrow({ where: { id: uploadId } });
    expect(JSON.parse(upload.extractedJson ?? "{}")).toMatchObject({ fxRate: 0.9123, fxSource: "ECB" });
  });

  it("keeps the owner's own euro figure when they typed one", async () => {
    const { uploadId } = await readOne(usdBill);
    const saved = await save(uploadId, { totalAmount: 44 });
    const body = await readJson(saved);
    expect(body.receipt.totalAmount).toBe(44);
    expect(body.fx).toBeNull();
  });
});

describe("a rate printed on the document", () => {
  it("wins over the ECB's and is recorded as the document's", async () => {
    const { reading } = await readOne({ ...usdBill, fxRate: 0.9 });
    expect(reading).toMatchObject({ totalAmount: 45.09, fxRate: 0.9, fxSource: "document" });
    expect(fxCalls).toHaveLength(0);
  });
});

describe("a euro receipt", () => {
  it("is untouched and never asks for a rate", async () => {
    const { uploadId, reading } = await readOne({
      ...usdBill,
      currency: "EUR",
      sellerCountry: "FI",
      originalAmount: null,
      totalAmount: 24.9,
      documentType: "receipt",
    });
    expect(reading).toMatchObject({ totalAmount: 24.9, fxRate: null, fxSource: null });
    const saved = await save(uploadId, { totalAmount: 24.9 });
    const body = await readJson(saved);
    expect(body.receipt.totalAmount).toBe(24.9);
    expect(body.receipt.currency).toBe("EUR");
    expect(fxCalls).toHaveLength(0);
  });
});
