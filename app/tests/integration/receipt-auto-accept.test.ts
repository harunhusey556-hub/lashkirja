import { beforeEach, describe, expect, it } from "vitest";
import { POST as saveReceipt } from "@/app/api/receipts/save/route";
import { PATCH as reviewReceipt } from "@/app/api/receipts/[id]/review/route";
import { prisma } from "@/lib/db";
import { alvReportOf, loadAlvPeriodSources } from "@/lib/alv-period";
import { AUTO_SAVE_CONCURRENCY, createLimiter } from "@/lib/auto-accept";
import {
  createStatementWithTransactions,
  createUpload,
  createUser,
  resetDatabase,
  type TestUser,
} from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";

/**
 * W8: a complete reading is saved AND approved by one POST /api/receipts/save
 * (`autoApprove: true`), inside the create's own transaction; anything the rule
 * refuses is saved as pending. The bookkeeping that results must be exactly
 * what the manual approve path (PATCH /review) produces.
 */

interface Reading {
  vendor: string | null;
  date: string | null;
  totalAmount: number | null;
  vatDetails: { rate: number; amount: number }[];
  category: string | null;
  documentType?: string | null;
}

const complete: Reading = {
  vendor: "K-Market Kamppi",
  date: "2026-01-14",
  totalAmount: 12.4,
  vatDetails: [{ rate: 14, amount: 1.52 }],
  category: "elintarvikkeet",
  documentType: "receipt",
};

async function stagedUpload(userId: string, reading: Reading, confidence = 0.85, source = "ai") {
  const upload = await createUpload(userId, { originalName: "kuitti.pdf" });
  await prisma.upload.update({
    where: { id: upload.id },
    data: {
      extractedJson: JSON.stringify({ ...reading, type: "meno", notes: null, reference: null, invoiceNumber: null }),
      extractionSource: source,
      confidence,
    },
  });
  return upload.id;
}

function saveBody(uploadId: string, reading: Reading, extra: Record<string, unknown> = {}) {
  return {
    uploadId,
    vendor: reading.vendor,
    date: reading.date,
    totalAmount: reading.totalAmount,
    vatDetails: reading.vatDetails,
    category: reading.category,
    type: "meno",
    ...extra,
  };
}

async function save(cookie: string, body: Record<string, unknown>) {
  const response = await saveReceipt(buildRequest("POST", "/api/receipts/save", body, { cookie }));
  return { status: response.status, body: await readJson(response) };
}

/** Everything the books read off one user's receipts for January 2026. */
async function bookkeeping(userId: string) {
  const receipts = await prisma.receipt.findMany({
    where: { userId },
    select: {
      reviewStatus: true,
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
    await loadAlvPeriodSources(userId, new Date("2026-01-01T00:00:00Z"), new Date("2026-02-01T00:00:00Z"))
  );
  const purchaseInvoices = await prisma.purchaseInvoice.count({ where: { userId } });
  return { receipts, report, purchaseInvoices };
}

let user: TestUser;
let cookie: string;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

describe("POST /api/receipts/save with autoApprove", () => {
  it("approves a complete reading in the same call, with the same books as a manual approve", async () => {
    // Manual path: the receipt waits in the review queue, the owner taps Hyväksy.
    const manualUser = await createUser();
    const manualCookie = await sessionCookie(manualUser);
    // The bank row is six days after the kuitti: a suggestion on both paths. Inside three days
    // amount + name confirm by themselves (match-gate TIGHT_DATE_DAYS), which is not this test.
    await createStatementWithTransactions(manualUser.id, {
      transactions: [{ date: "2026-01-20", amountCents: -1240, counterparty: "K-Market Kamppi" }],
    });
    const manual = await save(manualCookie, saveBody(await stagedUpload(manualUser.id, complete), complete, { autoApprove: true, forceDuplicate: true }));
    expect(manual.status).toBe(200);
    // forceDuplicate = the client acknowledged a look-alike: never auto-approved.
    expect(manual.body.receipt.reviewStatus).toBe("pending");
    expect(manual.body.autoApproved).toBe(false);
    const approve = await reviewReceipt(
      buildRequest("PATCH", `/api/receipts/${manual.body.receipt.id}/review`, { reviewStatus: "approved" }, { cookie: manualCookie }),
      routeContext({ id: manual.body.receipt.id })
    );
    expect(approve.status).toBe(200);
    // The review route does not re-run matching; the next save or import does.
    const { runMatching } = await import("@/lib/matching");
    await runMatching(manualUser.id);

    // Auto path: one POST.
    await createStatementWithTransactions(user.id, {
      transactions: [{ date: "2026-01-20", amountCents: -1240, counterparty: "K-Market Kamppi" }],
    });
    const auto = await save(cookie, saveBody(await stagedUpload(user.id, complete), complete, { autoApprove: true }));
    expect(auto.status).toBe(200);
    expect(auto.body.autoApproved).toBe(true);
    expect(auto.body.receipt.reviewStatus).toBe("approved");

    const autoBooks = await bookkeeping(user.id);
    const manualBooks = await bookkeeping(manualUser.id);
    expect(autoBooks.receipts[0].reviewStatus).toBe("approved");
    // The bank row is offered the same way on both paths.
    expect(autoBooks.receipts[0].suggestedTransactions).toEqual([{ amountCents: -1240 }]);
    expect(autoBooks).toEqual(manualBooks);
    expect(autoBooks.report).not.toEqual(alvReportOf({ receipts: [], invoices: [], purchaseInvoices: [] }));
  });

  it.each([
    ["missing vendor", { ...complete, vendor: null }],
    ["missing amount", { ...complete, totalAmount: null, vatDetails: [] }],
    ["zero amount", { ...complete, totalAmount: 0, vatDetails: [] }],
    ["missing date", { ...complete, date: null }],
    ["a flyer, not a receipt", { ...complete, documentType: "marketing" }],
  ])("saves an incomplete reading (%s) as pending", async (_label, reading) => {
    const result = await save(cookie, saveBody(await stagedUpload(user.id, reading), reading, { autoApprove: true }));
    expect(result.status).toBe(200);
    expect(result.body.autoApproved).toBe(false);
    const row = await prisma.receipt.findUniqueOrThrow({ where: { id: result.body.receipt.id } });
    expect(row.reviewStatus).toBe("pending");
  });

  it("saves a low-confidence reading and an unreadable file as pending", async () => {
    const low = await save(cookie, saveBody(await stagedUpload(user.id, complete, 0.4), complete, { autoApprove: true }));
    expect(low.body.receipt.reviewStatus).toBe("pending");
    const manual = await save(
      cookie,
      saveBody(await stagedUpload(user.id, { ...complete, date: "2026-01-15" }, 0, "manual"), { ...complete, date: "2026-01-15" }, { autoApprove: true })
    );
    expect(manual.body.receipt.reviewStatus).toBe("pending");
  });

  it("a likely duplicate is refused first, and saved as pending when the client insists", async () => {
    const first = await save(cookie, saveBody(await stagedUpload(user.id, complete), complete, { autoApprove: true }));
    expect(first.body.receipt.reviewStatus).toBe("approved");
    const secondUpload = await stagedUpload(user.id, complete);
    const refused = await save(cookie, saveBody(secondUpload, complete, { autoApprove: true }));
    expect(refused.status).toBe(409);
    const insisted = await save(cookie, saveBody(secondUpload, complete, { autoApprove: true, forceDuplicate: true }));
    expect(insisted.status).toBe(200);
    expect(insisted.body.receipt.reviewStatus).toBe("pending");
    // The kept look-alike says so in the review queue (two identical Shell Polska rows, 2026-10-15).
    expect(insisted.body.receipt.notes).toMatch(/^Mahdollinen kaksoiskappale/);
    expect(first.body.receipt.notes ?? "").not.toMatch(/kaksoiskappale/);
  });

  it("without the flag the form's save is unchanged (the owner's own save approves)", async () => {
    const result = await save(cookie, saveBody(await stagedUpload(user.id, complete), complete));
    expect(result.status).toBe(200);
    expect(result.body.receipt.reviewStatus).toBe("approved");
    expect(result.body.autoApproved).toBeUndefined();
  });
});

describe("bulk auto-save with bounded concurrency", () => {
  it("30 saves finish; one forced failure leaves 29 saved and does not stop the rest", async () => {
    const uploads: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      const reading = { ...complete, vendor: `Kauppa ${index}`, totalAmount: 10 + index, vatDetails: [] };
      uploads.push(await stagedUpload(user.id, reading));
    }
    // The forced failure: upload 7 is already claimed, as if saved from another tab.
    await prisma.upload.update({ where: { id: uploads[7] }, data: { claimedAt: new Date() } });

    const limit = createLimiter(AUTO_SAVE_CONCURRENCY);
    const results = await Promise.all(
      uploads.map((uploadId, index) =>
        limit(() =>
          save(cookie, {
            uploadId,
            vendor: `Kauppa ${index}`,
            date: complete.date,
            totalAmount: 10 + index,
            category: complete.category,
            type: "meno",
            autoApprove: true,
          })
        )
      )
    );

    expect(results.filter((result) => result.status === 200)).toHaveLength(29);
    expect(results[7].status).toBe(409);
    expect(await prisma.receipt.count({ where: { userId: user.id } })).toBe(29);
    expect(await prisma.receipt.count({ where: { userId: user.id, reviewStatus: "approved" } })).toBe(29);
  });
});
