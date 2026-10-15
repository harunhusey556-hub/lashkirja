import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as inbox } from "@/app/api/receipts/inbox/route";
import { PATCH as reviewReceipt } from "@/app/api/receipts/[id]/review/route";
import { prisma } from "@/lib/db";
import { alvReportOf, loadAlvPeriodSources } from "@/lib/alv-period";
import { runMatching } from "@/lib/matching";
import { processDocumentJob, setDocumentExtractorForTests } from "@/lib/document-jobs";
import { resetRateLimitsForTests } from "@/lib/rate-limit";
import type { ExtractedReceipt } from "@/lib/ai";
import {
  createReceipt,
  createStatementWithTransactions,
  createUser,
  resetDatabase,
  type TestUser,
} from "./helpers/factories";
import { buildFormRequest, buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

/**
 * W31 (final test on the owner's data): a photo the iPhone queued offline goes
 * through POST /api/receipts/inbox and the document job, and always ended
 * "pending" - W8's auto-accept was never applied, so the owner still approved
 * phone photos one by one. A complete phone reading must now end approved with
 * the same books a manual approve gives; everything W8's rule refuses stays
 * pending exactly as before, and AUTO_ACCEPT_COMPLETE_RECEIPTS stays the switch.
 */

// The switch is a constant; the test flips it through the module so the
// switched-off case runs the real inbox code, not a copy.
const flags = vi.hoisted(() => ({ autoAccept: true }));
vi.mock("@/lib/auto-accept", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auto-accept")>();
  return {
    ...actual,
    get AUTO_ACCEPT_COMPLETE_RECEIPTS() {
      return flags.autoAccept;
    },
    canAutoAccept: (input: Parameters<typeof actual.canAutoAccept>[0]) =>
      flags.autoAccept && actual.autoAcceptBlock(input) === null,
  };
});

// The route would start the job after its response; the test runs it itself,
// so the post-commit matching has finished when the receipt is read.
vi.mock("@/lib/job-tracker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/job-tracker")>()),
  runAfterResponse: () => {},
}));

const kuitti: ExtractedReceipt = {
  vendor: "K-Market Kamppi",
  date: "2026-09-14",
  totalAmount: 12.4,
  vatDetails: [{ rate: 14, amount: 1.52 }],
  category: "elintarvikkeet",
  notes: null,
  type: "meno",
  reference: null,
  invoiceNumber: null,
  source: "ai",
  provenance: "openai-compatible",
  confidence: 0.9,
  documentType: "receipt",
  currency: "EUR",
};

const VIITE = "20260627012";
const bill: ExtractedReceipt = {
  ...kuitti,
  vendor: "Kampaamotukku Oy",
  totalAmount: 100.5,
  vatDetails: [{ rate: 25.5, amount: 20.42 }],
  category: "tarvikkeet",
  reference: VIITE,
  invoiceNumber: "1234",
  documentType: "invoice",
  sellerCountry: "FI",
  dueDate: "2026-09-28",
};

let user: TestUser;
let cookie: string;
let photo = 0;

function jpeg(): File {
  photo += 1;
  return new File([Uint8Array.from([0xff, 0xd8, 0xff, photo, 0xd9])], "kuitti.jpg", { type: "image/jpeg" });
}

/** One phone capture through the real inbox route and document job; returns its receipt. */
async function capture(owner: { cookie: string; userId: string }, reading: ExtractedReceipt) {
  setDocumentExtractorForTests(async () => reading);
  const form = new FormData();
  form.set("file", jpeg());
  form.set("capturedAt", "2026-09-14T09:00:00.000Z");
  const response = await inbox(
    buildFormRequest("/api/receipts/inbox", form, {
      cookie: owner.cookie,
      headers: { "idempotency-key": `w31-${photo}` },
    })
  );
  expect(response.status).toBe(201);
  const { jobId, uploadId } = await readJson<{ jobId: string; uploadId: string }>(response);
  await processDocumentJob(jobId);
  expect((await prisma.backgroundJob.findUniqueOrThrow({ where: { id: jobId } })).status).toBe("done");
  return prisma.receipt.findFirstOrThrow({ where: { userId: owner.userId, uploadId } });
}

/** Everything the books read off one user's receipts for September 2026. */
async function bookkeeping(userId: string) {
  const receipts = await prisma.receipt.findMany({
    where: { userId },
    select: {
      reviewStatus: true,
      source: true,
      vendor: true,
      date: true,
      totalAmountCents: true,
      vatDetails: true,
      category: true,
      currency: true,
      vatTreatment: true,
      type: true,
      linkedTransaction: { select: { matchStatus: true, amountCents: true } },
      suggestedTransactions: { select: { amountCents: true } },
    },
  });
  const report = alvReportOf(
    await loadAlvPeriodSources(userId, new Date("2026-09-01T00:00:00Z"), new Date("2026-10-01T00:00:00Z"))
  );
  const purchaseInvoices = await prisma.purchaseInvoice.count({ where: { userId } });
  return { receipts, report, purchaseInvoices };
}

beforeEach(async () => {
  flags.autoAccept = true;
  resetRateLimitsForTests();
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

afterEach(() => {
  flags.autoAccept = true;
  setDocumentExtractorForTests(null);
});

describe("phone inbox capture with auto-accept (W31)", () => {
  it("approves a complete phone reading, with the same books as a manual approve", async () => {
    // Manual path: today's pending capture, then the owner taps Hyväksy.
    const manualUser = await createUser();
    const manualCookie = await sessionCookie(manualUser);
    await createStatementWithTransactions(manualUser.id, {
      periodMonth: "2026-09",
      transactions: [{ date: "2026-09-14", amountCents: -1240, counterparty: "K-Market Kamppi" }],
    });
    flags.autoAccept = false;
    const pending = await capture({ cookie: manualCookie, userId: manualUser.id }, kuitti);
    expect(pending.reviewStatus).toBe("pending");
    flags.autoAccept = true;
    const approve = await reviewReceipt(
      buildRequest("PATCH", `/api/receipts/${pending.id}/review`, { reviewStatus: "approved" }, { cookie: manualCookie }),
      routeContext({ id: pending.id })
    );
    expect(approve.status).toBe(200);
    // The review route does not re-run matching; the next save or import does.
    await runMatching(manualUser.id);

    // Auto path: the capture alone.
    await createStatementWithTransactions(user.id, {
      periodMonth: "2026-09",
      transactions: [{ date: "2026-09-14", amountCents: -1240, counterparty: "K-Market Kamppi" }],
    });
    const auto = await capture({ cookie, userId: user.id }, kuitti);
    expect(auto).toMatchObject({ source: "app_capture", reviewStatus: "approved", totalAmountCents: 1240 });

    const autoBooks = await bookkeeping(user.id);
    const manualBooks = await bookkeeping(manualUser.id);
    expect(autoBooks).toEqual(manualBooks);
    // Post-save matching ran on the inbox path too: the bank row is not left unasked.
    const bankRow = autoBooks.receipts[0].linkedTransaction ?? autoBooks.receipts[0].suggestedTransactions[0];
    expect(bankRow?.amountCents).toBe(-1240);
    expect(autoBooks.report.field307.amount).toBeGreaterThan(0);
  });

  it("leaves an incomplete phone reading pending, as today", async () => {
    const noVendor = await capture({ cookie, userId: user.id }, { ...kuitti, vendor: null });
    const noAmount = await capture({ cookie, userId: user.id }, { ...kuitti, totalAmount: null, vatDetails: [] });
    const unsure = await capture({ cookie, userId: user.id }, { ...kuitti, confidence: 0.3 });
    const flyer = await capture({ cookie, userId: user.id }, { ...kuitti, documentType: "marketing" });
    // No date read: the receipt carries the capture day, but the reading was not complete.
    const noDate = await capture({ cookie, userId: user.id }, { ...kuitti, date: null });
    for (const receipt of [noVendor, noAmount, unsure, flyer, noDate]) {
      expect(receipt.reviewStatus).toBe("pending");
    }
    expect(noDate.date).not.toBeNull();
  });

  it("leaves a look-alike of a receipt already on file pending", async () => {
    await createReceipt(user.id, { vendor: "K-Market Kamppi", date: "2026-09-14", totalAmountCents: 1240 });
    const lookAlike = await capture({ cookie, userId: user.id }, kuitti);
    expect(lookAlike.reviewStatus).toBe("pending");
    expect(lookAlike.notes).toMatch(/^Mahdollinen kaksoiskappale/);
  });

  it("leaves a capture dated in a closed period pending", async () => {
    await prisma.user.update({ where: { id: user.id }, data: { booksLockedThrough: "2026-09" } });
    const locked = await capture({ cookie, userId: user.id }, kuitti);
    expect(locked.reviewStatus).toBe("pending");
  });

  it("approves a photographed bill as one ostolasku, paid by the bank row carrying its viite", async () => {
    const statement = await createStatementWithTransactions(user.id, {
      periodMonth: "2026-09",
      transactions: [{ date: "2026-09-20", amountCents: -10_050, counterparty: "KAMPAAMOTUKKU OY" }],
    });
    await prisma.transaction.update({ where: { id: statement.transactions[0].id }, data: { reference: VIITE } });

    const receipt = await capture({ cookie, userId: user.id }, bill);
    expect(receipt.reviewStatus).toBe("approved");
    const invoices = await prisma.purchaseInvoice.findMany({ where: { userId: user.id }, include: { payments: true } });
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ receiptId: receipt.id, invoiceNumber: "1234", grossCents: 10_050 });
    // The save route's post-save purchase matching ran for the phone bill too (W27).
    expect(invoices[0].status).toBe("paid");
    expect(invoices[0].payments.map((payment) => payment.amountCents)).toEqual([10_050]);
  });

  it("keeps today's behaviour when AUTO_ACCEPT_COMPLETE_RECEIPTS is off", async () => {
    flags.autoAccept = false;
    await createStatementWithTransactions(user.id, {
      periodMonth: "2026-09",
      transactions: [{ date: "2026-09-14", amountCents: -1240, counterparty: "K-Market Kamppi" }],
    });
    const receipt = await capture({ cookie, userId: user.id }, kuitti);
    expect(receipt.reviewStatus).toBe("pending");
    const books = await bookkeeping(user.id);
    expect(books.receipts[0].linkedTransaction).toBeNull();
    expect(books.receipts[0].suggestedTransactions).toEqual([]);
  });
});
