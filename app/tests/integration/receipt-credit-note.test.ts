import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as saveReceipt } from "@/app/api/receipts/save/route";
import { GET as getReceipt, PATCH as patchReceipt } from "@/app/api/receipts/[id]/route";
import { GET as bankCandidates } from "@/app/api/receipts/[id]/bank-candidates/route";
import { PATCH as reviewReceipt } from "@/app/api/receipts/[id]/review/route";
import { POST as inbox } from "@/app/api/receipts/inbox/route";
import { POST as createPurchase } from "@/app/api/purchase-invoices/route";
import { GET as alv } from "@/app/api/alv/route";
import { prisma } from "@/lib/db";
import { parseOCRText, type ExtractedReceipt } from "@/lib/ai";
import { processDocumentJob, setDocumentExtractorForTests } from "@/lib/document-jobs";
import { storeEmailDocument } from "@/lib/mail-sync";
import { loadLedger } from "@/lib/ledger/load";
import { buildInlineCandidates, runMatching } from "@/lib/matching";
import { resetRateLimitsForTests } from "@/lib/rate-limit";
import { applyReceiptPatch } from "@/lib/receipt-update";
import {
  createReceipt,
  createStatementWithTransactions,
  createUpload,
  createUser,
  resetDatabase,
  type TestUser,
} from "./helpers/factories";
import { buildFormRequest, buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

/**
 * Item 5 of the owner wave ("Does the platform detect credit notes?"): a credit
 * note read from a file is stored negative on every intake path, whether its total
 * was printed "-125,50" or "125,50 Hyvitys"; it waits for the owner instead of
 * being approved; a supplier credit note naming an ostolasku of the same supplier
 * is filed as that invoice's credit (creditsInvoiceId); and the period's deductible
 * VAT goes down by its VAT.
 */

// The inbox route would start the job after its response; the test runs it itself.
vi.mock("@/lib/job-tracker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/job-tracker")>()),
  runAfterResponse: () => {},
}));

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

let user: TestUser;
let cookie: string;

const PERIOD = "2026-08";

// The ostolasku being credited: 100,00 € + 25,5 % VAT.
const ORIGINAL = {
  supplierName: "Tukku Oy",
  invoiceNumber: "1234",
  issueDate: `${PERIOD}-10`,
  dueDate: `${PERIOD}-24`,
  gross: 125.5,
  vat: 25.5,
  category: "tarvikkeet",
};

/** The reading of a Finnish supplier credit note, as the model returns it: positive sizes and the flag. */
const fiCredit: ExtractedReceipt = {
  vendor: "Tukku Oy",
  date: `${PERIOD}-15`,
  totalAmount: 125.5,
  vatDetails: [{ rate: 25.5, amount: 25.5 }],
  category: "tarvikkeet",
  notes: "Hyvityslasku: summa ja ALV kirjataan negatiivisina.",
  type: "meno",
  reference: null,
  invoiceNumber: "H-77",
  source: "ai",
  provenance: "openai-compatible",
  confidence: 0.9,
  documentType: "invoice",
  currency: "EUR",
  sellerCountry: "FI",
  isCreditNote: true,
  creditsInvoiceNumber: "1234",
};

beforeEach(async () => {
  resetRateLimitsForTests();
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

afterEach(() => {
  setDocumentExtractorForTests(null);
});

async function makeOriginal(overrides: Record<string, unknown> = {}): Promise<Json> {
  const response = await createPurchase(
    buildRequest("POST", "/api/purchase-invoices", { ...ORIGINAL, ...overrides }, { cookie })
  );
  expect(response.status).toBe(201);
  return (await readJson(response)).invoice;
}

/** An upload whose stored reading is `reading`, as the document job leaves it. */
async function stagedUpload(reading: ExtractedReceipt): Promise<string> {
  const upload = await createUpload(user.id, { originalName: "hyvityslasku.pdf" });
  await prisma.upload.update({
    where: { id: upload.id },
    data: { extractedJson: JSON.stringify(reading), extractionSource: "ai", confidence: reading.confidence },
  });
  return upload.id;
}

/** The form's save: it shows a credit note's amounts as positive sizes unless `amounts` says otherwise. */
async function save(reading: ExtractedReceipt, amounts: { total: number; vat: number } | null = null) {
  const uploadId = await stagedUpload(reading);
  const response = await saveReceipt(
    buildRequest(
      "POST",
      "/api/receipts/save",
      {
        uploadId,
        vendor: reading.vendor,
        date: reading.date,
        totalAmount: amounts ? amounts.total : reading.totalAmount,
        vatDetails: amounts ? [{ rate: 25.5, amount: amounts.vat }] : reading.vatDetails,
        category: reading.category,
        notes: reading.notes,
        type: "meno",
        invoiceNumber: reading.invoiceNumber,
        autoApprove: true,
      },
      { cookie }
    )
  );
  return { status: response.status, body: await readJson<Json>(response) };
}

async function deductibleVat(): Promise<number> {
  const response = await alv(buildRequest("GET", `/api/alv?period=${PERIOD}`, undefined, { cookie }));
  expect(response.status).toBe(200);
  return (await readJson<Json>(response)).field307.amount;
}

async function approve(receiptId: string) {
  const response = await reviewReceipt(
    buildRequest("PATCH", `/api/receipts/${receiptId}/review`, { reviewStatus: "approved" }, { cookie }),
    routeContext({ id: receiptId })
  );
  expect(response.status).toBe(200);
}

describe("POST /api/receipts/save with a credit note", () => {
  it("stores it negative, leaves it pending, files it against the ostolasku it names, and lowers the VAT", async () => {
    const original = await makeOriginal();
    expect(await deductibleVat()).toBe(25.5);

    const saved = await save(fiCredit);
    expect(saved.status).toBe(200);
    // Never approved blind, never with a positive sign.
    expect(saved.body.autoApproved).toBe(false);
    expect(saved.body.receipt).toMatchObject({ totalAmount: -125.5, reviewStatus: "pending", type: "meno" });
    const stored = await prisma.receipt.findUniqueOrThrow({ where: { id: saved.body.receipt.id } });
    expect(stored.totalAmountCents).toBe(-12_550);
    expect(JSON.parse(stored.vatDetails ?? "[]")).toEqual([{ rate: 25.5, amount: -25.5 }]);

    // Filed as the original's credit note, through the same path as a credit typed in by hand.
    expect(saved.body.purchaseInvoice).toMatchObject({
      isCreditNote: true,
      creditsInvoiceId: original.id,
      gross: -125.5,
      vat: -25.5,
      invoiceNumber: "H-77",
      receiptId: stored.id,
    });
    const credited = await prisma.purchaseInvoice.findUniqueOrThrow({ where: { id: original.id } });
    expect(credited.status).toBe("credited");

    // 25,50 deducted for the invoice, 25,50 taken back by its credit note: the receipt is not counted on top.
    expect(await deductibleVat()).toBe(0);
    await approve(stored.id);
    expect(await deductibleVat()).toBe(0);
  });

  it("books a total sent with its printed minus the same way, and links an English 'Original invoice INV-1234'", async () => {
    const original = await makeOriginal({ invoiceNumber: "INV-1234", supplierName: "Northwind Ltd" });
    const saved = await save(
      { ...fiCredit, vendor: "Northwind Ltd", invoiceNumber: "CN-77", creditsInvoiceNumber: "INV 1234" },
      { total: -125.5, vat: -25.5 }
    );
    expect(saved.status).toBe(200);
    expect((await prisma.receipt.findUniqueOrThrow({ where: { id: saved.body.receipt.id } })).totalAmountCents).toBe(-12_550);
    expect(saved.body.purchaseInvoice).toMatchObject({ creditsInvoiceId: original.id, gross: -125.5 });
  });

  it("files a credit note naming no ostolasku of that supplier on its own, linked to nothing", async () => {
    const other = await makeOriginal({ supplierName: "Toinen Tukku Oy" });
    const saved = await save({ ...fiCredit, creditsInvoiceNumber: "9999" });
    expect(saved.status).toBe(200);
    expect(saved.body.purchaseInvoice).toMatchObject({ isCreditNote: true, creditsInvoiceId: null, gross: -125.5, vat: -25.5 });
    // The same number from another supplier is not this credit's invoice either.
    const sameNumberOtherSupplier = await save({ ...fiCredit, date: `${PERIOD}-16`, invoiceNumber: "H-78", creditsInvoiceNumber: "1234" });
    expect(sameNumberOtherSupplier.status).toBe(200);
    expect(sameNumberOtherSupplier.body.purchaseInvoice.creditsInvoiceId).toBeNull();
    expect((await prisma.purchaseInvoice.findUniqueOrThrow({ where: { id: other.id } })).status).toBe("open");
    expect(await deductibleVat()).toBe(25.5 - 25.5 - 25.5);
  });

  it("still books a credit for more than the named invoice has left, on its own", async () => {
    const original = await makeOriginal({ gross: 62.75, vat: 12.75 });
    const saved = await save(fiCredit);
    expect(saved.body.purchaseInvoice).toMatchObject({ creditsInvoiceId: null, gross: -125.5 });
    expect((await prisma.purchaseInvoice.findUniqueOrThrow({ where: { id: original.id } })).status).toBe("open");
  });

  it("refuses a negative amount on a reading that is not a credit note", async () => {
    const saved = await save({ ...fiCredit, isCreditNote: false, creditsInvoiceNumber: null, notes: null }, { total: -125.5, vat: -25.5 });
    expect(saved.status).toBe(400);
    expect(saved.body.error.message).toBe("Negatiivinen summa kirjataan vain hyvityslaskulle.");
    expect(await prisma.receipt.count()).toBe(0);
  });

  it("keeps a stored credit note editable with its negative amounts", async () => {
    const saved = await save({ ...fiCredit, creditsInvoiceNumber: null });
    const id = saved.body.receipt.id;
    const edit = await patchReceipt(
      buildRequest("PATCH", `/api/receipts/${id}`, { totalAmount: -125.5, vatDetails: [{ rate: 25.5, amount: -25.5 }], category: "muut" }, { cookie }),
      routeContext({ id })
    );
    expect(edit.status).toBe(200);
    expect((await readJson<Json>(edit)).receipt).toMatchObject({ totalAmount: -125.5, category: "muut" });
  });

  // Ultrareview PR #31: one rule (negativeAmountProblem) in the write both PATCH and Hyväksy use.
  it("an ordinary receipt refuses a negative original amount on PATCH, and a negative total on Hyväksy", async () => {
    const ordinary = await createReceipt(user.id, { totalAmountCents: 100_00 });
    const edit = await patchReceipt(
      buildRequest("PATCH", `/api/receipts/${ordinary.id}`, { originalAmount: -90 }, { cookie }),
      routeContext({ id: ordinary.id })
    );
    expect(edit.status).toBe(400);
    expect((await readJson<Json>(edit)).error.message).toBe("Negatiivinen summa kirjataan vain hyvityslaskulle.");
    await expect(applyReceiptPatch(user.id, ordinary.id, { totalAmount: -100 })).rejects.toThrow(
      "Negatiivinen summa kirjataan vain hyvityslaskulle."
    );
    expect((await prisma.receipt.findUniqueOrThrow({ where: { id: ordinary.id } })).totalAmountCents).toBe(100_00);
  });
});

describe("a credit's VAT follows its total's sign (review 2026-10-16)", () => {
  const patch = (id: string, body: Record<string, unknown>) =>
    patchReceipt(buildRequest("PATCH", `/api/receipts/${id}`, body, { cookie }), routeContext({ id }));

  it("PATCH refuses positive VAT on a negative total, and a positive total under stored negative VAT", async () => {
    const saved = await save({ ...fiCredit, creditsInvoiceNumber: null });
    const id = saved.body.receipt.id;
    const positiveVat = await patch(id, { totalAmount: -125.5, vatDetails: [{ rate: 25.5, amount: 25.5 }] });
    expect(positiveVat.status).toBe(400);
    expect((await readJson<Json>(positiveVat)).error.message).toMatch(/etumerkki/);
    const positiveTotal = await patch(id, { totalAmount: 125.5 });
    expect(positiveTotal.status).toBe(400);
    expect((await readJson<Json>(positiveTotal)).error.message).toMatch(/etumerkki/);
    const stored = await prisma.receipt.findUniqueOrThrow({ where: { id } });
    expect(stored.totalAmountCents).toBe(-12_550);
    expect(JSON.parse(stored.vatDetails!)).toEqual([{ rate: 25.5, amount: -25.5 }]);
  });

  it("save books a credit note read with mixed signs negative throughout", async () => {
    const saved = await save({ ...fiCredit, creditsInvoiceNumber: null }, { total: -125.5, vat: 25.5 });
    expect(saved.status).toBe(200);
    const stored = await prisma.receipt.findUniqueOrThrow({ where: { id: saved.body.receipt.id } });
    expect(stored.totalAmountCents).toBe(-12_550);
    expect(JSON.parse(stored.vatDetails!).every((line: { amount: number }) => line.amount <= 0)).toBe(true);
  });

  it("a negative 'tulo' (a refund of a sale) posts the mirror of a sale, as the VAT return counts it", async () => {
    const refund = await createReceipt(user.id, {
      type: "tulo",
      date: `${PERIOD}-10`,
      totalAmountCents: -12_550,
      category: "myynti",
      vendor: "Asiakas",
      vatDetails: JSON.stringify([{ rate: 25.5, amount: -25.5 }]),
    });
    const entries = await loadLedger(user.id, new Date("2026-12-31T00:00:00.000Z"));
    const entry = entries.find((candidate) => candidate.sourceId === refund.id);
    expect(entry).toBeDefined();
    const net = Object.fromEntries(entry!.lines.map((line) => [line.account, line.debitCents - line.creditCents]));
    // Not linked to a bank row: the payer side is the suspense account. Sales and output VAT go down.
    expect(net).toEqual({ "2990": -12_550, "3000": 10_000, "2939": 2_550 });
  });
});

describe("a shop's refund receipt (a credit that is not an ostolasku)", () => {
  const refund: ExtractedReceipt = {
    ...fiCredit,
    vendor: "Rautakauppa Oy",
    totalAmount: 25.1,
    vatDetails: [{ rate: 25.5, amount: 5.1 }],
    documentType: "receipt",
    invoiceNumber: null,
    creditsInvoiceNumber: null,
  };

  it("counts its VAT negative in the return and posts a smaller expense in the books", async () => {
    const saved = await save(refund);
    expect(saved.status).toBe(200);
    expect(saved.body.purchaseInvoice).toBeNull();
    await approve(saved.body.receipt.id);
    expect(await deductibleVat()).toBe(-5.1);

    const entries = await loadLedger(user.id, new Date("2026-12-31T00:00:00.000Z"));
    const entry = entries.find((candidate) => candidate.sourceId === saved.body.receipt.id);
    expect(entry).toBeDefined();
    const net = new Map(entry!.lines.map((line) => [line.account, line.debitCents - line.creditCents]));
    // The expense and the input VAT go down; the payer side is credited back.
    expect([...net.values()].filter((cents) => cents < 0).reduce((sum, cents) => sum + cents, 0)).toBe(-2_510);
    expect(Math.min(...net.values())).toBe(-2_000);
  });
});

describe("the phone inbox and email import", () => {
  let photo = 0;
  async function capture(reading: ExtractedReceipt) {
    setDocumentExtractorForTests(async () => reading);
    photo += 1;
    const form = new FormData();
    form.set("file", new File([Uint8Array.from([0xff, 0xd8, 0xff, photo, 0xd9])], "hyvitys.jpg", { type: "image/jpeg" }));
    form.set("capturedAt", `${PERIOD}-15T09:00:00.000Z`);
    const response = await inbox(
      buildFormRequest("/api/receipts/inbox", form, { cookie, headers: { "idempotency-key": `credit-${photo}` } })
    );
    expect(response.status).toBe(201);
    const { jobId, uploadId } = await readJson<{ jobId: string; uploadId: string }>(response);
    await processDocumentJob(jobId);
    expect((await prisma.backgroundJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("done");
    return prisma.receipt.findFirstOrThrow({ where: { userId: user.id, uploadId }, include: { purchaseInvoice: true } });
  }

  it("a photographed credit note is stored negative, pending, and filed against its invoice", async () => {
    const original = await makeOriginal();
    const receipt = await capture(fiCredit);
    expect(receipt.totalAmountCents).toBe(-12_550);
    expect(receipt.reviewStatus).toBe("pending");
    expect(receipt.purchaseInvoice).toMatchObject({ grossCents: -12_550, vatCents: -2_550, creditsInvoiceId: original.id });
    expect(await deductibleVat()).toBe(0);
  });

  it("a credit note read by local OCR ('HYVITYSLASKU ... Yhteensä -125,50') is stored negative", async () => {
    const text = [
      "Tukku Oy",
      "HYVITYSLASKU",
      `Päivämäärä 15.08.2026`,
      "Hyvitettävä lasku 1234",
      "ALV 25,5 % 100,00 25,50",
      "Yhteensä -125,50 €",
    ].join("\n");
    const receipt = await capture(parseOCRText(text));
    expect(receipt.totalAmountCents).toBe(-12_550);
    expect(receipt.reviewStatus).toBe("pending");
    expect(JSON.parse(receipt.vatDetails ?? "[]")).toEqual([{ rate: 25.5, amount: -25.5 }]);
    const upload = await prisma.upload.findUniqueOrThrow({ where: { id: receipt.uploadId! } });
    expect(JSON.parse(upload.extractedJson ?? "{}")).toMatchObject({ isCreditNote: true, creditsInvoiceNumber: "1234" });
  });

  it("an emailed credit note is stored negative and filed against its invoice", async () => {
    const original = await makeOriginal();
    const isBill = await storeEmailDocument({
      userId: user.id,
      accountEmail: "laskut@example.com",
      content: Buffer.from("%PDF-1.4 hyvityslasku"),
      filename: "hyvityslasku.pdf",
      ext: ".pdf",
      mimeType: "application/pdf",
      checksum: "email-credit-1",
      mailDate: new Date(`${PERIOD}-15T08:00:00.000Z`),
      extraction: fiCredit,
    });
    expect(isBill).toBe(true);
    const receipt = await prisma.receipt.findFirstOrThrow({
      where: { userId: user.id, source: "email_sync" },
      include: { purchaseInvoice: true },
    });
    expect(receipt.totalAmountCents).toBe(-12_550);
    expect(receipt.reviewStatus).toBe("pending");
    expect(receipt.purchaseInvoice).toMatchObject({ grossCents: -12_550, creditsInvoiceId: original.id });
  });
});

// X069: the money a credit note brings back arrives as an incoming row. A payment out to the
// same supplier for the same sum is never offered as its match, on the receipt or the bank side.
describe("a credit note's bank rows", () => {
  async function creditWithRows() {
    const credit = await createReceipt(user.id, {
      date: `${PERIOD}-15`,
      totalAmountCents: -50_00,
      vatDetails: JSON.stringify([{ rate: 25.5, amount: -10.16 }]),
      reviewStatus: "pending",
    });
    const statement = await createStatementWithTransactions(user.id, {
      periodMonth: PERIOD,
      transactions: [
        { date: `${PERIOD}-16`, amountCents: -50_00, counterparty: "Tukku Oy" },
        { date: `${PERIOD}-16`, amountCents: 50_00, counterparty: "Tukku Oy" },
      ],
    });
    const out = statement.transactions.find((row) => row.amountCents < 0)!;
    const back = statement.transactions.find((row) => row.amountCents > 0)!;
    return { credit, out, back, rows: statement.transactions };
  }

  it("the receipt's own candidates hold only the incoming row", async () => {
    const { credit, back } = await creditWithRows();
    const response = await getReceipt(
      buildRequest("GET", `/api/receipts/${credit.id}`, undefined, { cookie }),
      routeContext({ id: credit.id })
    );
    expect(response.status).toBe(200);
    const { match } = (await readJson<Json>(response)).receipt;
    expect(match.status).toBe("unlinked");
    expect(match.matchCandidates.map((c: Json) => c.id)).toEqual([back.id]);
  });

  it("'Valitse muu pankkitapahtuma' lists only incoming rows", async () => {
    const { credit, back } = await creditWithRows();
    const response = await bankCandidates(
      buildRequest("GET", `/api/receipts/${credit.id}/bank-candidates`, undefined, { cookie }),
      routeContext({ id: credit.id })
    );
    expect(response.status).toBe(200);
    const body = await readJson<Json>(response);
    expect(body.candidates.map((c: Json) => c.transactionId)).toEqual([back.id]);
    expect(body.total).toBe(1);
  });

  it("the payment out never gets the credit note as its suggestion; the refund does", async () => {
    const { credit, out, back, rows } = await creditWithRows();
    const inline = await buildInlineCandidates(user.id, rows);
    expect(inline.get(out.id)?.map((c) => c.receipt.id) ?? []).not.toContain(credit.id);
    expect(inline.get(back.id)?.map((c) => c.receipt.id)).toEqual([credit.id]);

    await runMatching(user.id);
    const [outAfter, backAfter] = await Promise.all([
      prisma.transaction.findUniqueOrThrow({ where: { id: out.id } }),
      prisma.transaction.findUniqueOrThrow({ where: { id: back.id } }),
    ]);
    expect(outAfter).toMatchObject({ suggestedReceiptId: null, receiptId: null, matchStatus: "unmatched" });
    // Pending, so it waits as a suggestion for the owner instead of posting.
    expect(backAfter).toMatchObject({ suggestedReceiptId: credit.id, receiptId: null, matchStatus: "suggested" });
  });
});
