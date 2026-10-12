import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { runMatching, buildReceiptMatchViews } from "@/lib/matching";
import { dismissIncomeDraft } from "@/lib/income-automation";
import { centsToEuros } from "@/lib/money";
import { storedFxRate } from "@/lib/fx-rates";
import { removeUserUpload } from "@/lib/storage";
import { isoDateSchema, nonnegativeMoneySchema } from "@/lib/validation";
import {
  noStoreJson,
  rejectCrossSite,
  rejectOversizedContentLength,
} from "@/lib/http-security";
import { withErrorHandler, UnauthorizedError, AppError } from "@/lib/api-errors";

import { assertPeriodOpen } from "@/lib/period-lock";
import { expectedUpdatedAtDate } from "@/lib/edit-conflict";
import { applyReceiptPatch, UPDATED_RECEIPT_SELECT } from "@/lib/receipt-update";
import { matchPurchasePaymentsFromBank, syncReceiptDocumentKind } from "@/lib/purchase-invoices";
import { PURCHASE_VAT_TREATMENTS } from "@/lib/alv";
import { currencySchema } from "@/lib/foreign-purchase-input";
const patchSchema = z.object({
  vendor: z.string().trim().max(300).nullish(),
  date: isoDateSchema.nullish(),
  totalAmount: nonnegativeMoneySchema.nullish(),
  vatDetails: z.array(z.object({
    rate: z.number().finite().min(0).max(100),
    amount: nonnegativeMoneySchema,
  })).max(20).nullish(),
  category: z.string().trim().max(100).nullish(),
  notes: z.string().trim().max(500).nullish(),
  type: z.enum(["meno", "tulo"]).optional(),
  reference: z.string().trim().max(40).nullish(),
  invoiceNumber: z.string().trim().max(40).nullish(),
  currency: currencySchema.optional(),
  originalAmount: nonnegativeMoneySchema.nullish(),
  vatTreatment: z.enum(PURCHASE_VAT_TREATMENTS).optional(),
  // The owner's own kuitti / lasku choice: "invoice" files (or reopens) the ostolasku, "receipt" cancels it.
  documentType: z.enum(["invoice", "receipt"]).optional(),
  expectedUpdatedAt: z.string().max(40).optional(),
}).strict();

async function findOwnedReceipt(id: string, userId: string) {
  return prisma.receipt.findFirst({ where: { id, userId } });
}

export const GET = withErrorHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError("Ei kirjautunut");
  const { id } = await params;
  const receipt = await prisma.receipt.findFirst({
    where: { id, userId: session.userId! },
    select: {
      id: true,
      vendor: true,
      date: true,
      totalAmountCents: true,
      // The native app shows Hyväksy / Hylkää from it.
      reviewStatus: true,
      vatDetails: true,
      category: true,
      notes: true,
      type: true,
      reference: true,
      invoiceNumber: true,
      currency: true,
      originalAmountCents: true,
      vatTreatment: true,
      fileName: true,
      source: true,
      confidence: true,
      createdAt: true,
      updatedAt: true,
      // Only to surface the ECB / document rate behind a foreign receipt; the raw reading is not sent.
      upload: { select: { extractedJson: true } },
      linkedTransaction: {
        select: {
          id: true,
          date: true,
          counterparty: true,
          amountCents: true,
          matchStatus: true,
          matchScore: true,
          matchReasons: true,
          statement: { select: { periodMonth: true, fileName: true } },
        },
      },
    },
  });
  if (!receipt) return noStoreJson({ error: "Kuittia ei löytynyt" }, { status: 404 });

  const { totalAmountCents, originalAmountCents, linkedTransaction, upload, ...safe } = receipt;
  const totalAmount = totalAmountCents == null ? null : centsToEuros(totalAmountCents);
  const originalAmount = originalAmountCents == null ? null : centsToEuros(originalAmountCents);
  const matchViews = await buildReceiptMatchViews(session.userId!, [
    {
      id: receipt.id,
      vendor: receipt.vendor,
      date: receipt.date,
      totalAmount,
      type: receipt.type,
      reference: receipt.reference,
      invoiceNumber: receipt.invoiceNumber,
      linkedTransaction,
    },
  ]);
  const match = matchViews.get(receipt.id);

  return noStoreJson({
    receipt: {
      ...safe,
      totalAmount,
      originalAmount,
      ...storedFxRate(upload?.extractedJson),
      linkedTransaction: match?.linkedTransaction
        ? {
            id: match.linkedTransaction.id,
            date: match.linkedTransaction.date?.toISOString() ?? null,
            counterparty: match.linkedTransaction.counterparty,
            amount: match.linkedTransaction.amount,
            matchScore: match.linkedTransaction.matchScore,
            matchReasons: match.linkedTransaction.matchReasons,
            statement: match.linkedTransaction.statement,
          }
        : null,
      match: {
        status: match?.status ?? "unlinked",
        suggestedTransaction: match?.suggestedTransaction
          ? {
              ...match.suggestedTransaction,
              date: match.suggestedTransaction.date?.toISOString() ?? null,
            }
          : null,
        matchCandidates: (match?.matchCandidates ?? []).map((c) => ({
          ...c,
          date: c.date?.toISOString() ?? null,
        })),
      },
    },
  });
});

export const PATCH = withErrorHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError("Ei kirjautunut");
  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req);
  if (oversized) return oversized;

  const { id } = await params;
  const owned = await findOwnedReceipt(id, session.userId!);
  if (!owned) {
    return noStoreJson({ error: "Kuittia ei löytynyt" }, { status: 404 });
  }
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  // The shared 400 answer names the field and the limit in Finnish (F64).
  if (!parsed.success) throw parsed.error;
  if (Object.keys(parsed.data).length === 0) {
    return noStoreJson({ error: "Ei päivitettäviä kenttiä" }, { status: 400 });
  }
  const { expectedUpdatedAt, documentType, ...body } = parsed.data;
  if (Object.keys(body).length === 0 && !documentType) {
    return noStoreJson({ error: "Ei päivitettäviä kenttiä" }, { status: 400 });
  }
  const expected = expectedUpdatedAtDate(expectedUpdatedAt);

  // The same write the assistant's accepted receipt_update uses (lib/receipt-update.ts).
  const receipt =
    Object.keys(body).length > 0
      ? await applyReceiptPatch(session.userId!, id, body, { expected })
      : await prisma.receipt.findFirstOrThrow({ where: { id, userId: session.userId! }, select: UPDATED_RECEIPT_SELECT });

  // An explicit kind always applies (its errors reach the owner); without one, a
  // receipt read as a bill is filed once the edit gave it what an ostolasku needs.
  let kind: Awaited<ReturnType<typeof syncReceiptDocumentKind>> | null = null;
  if (documentType) {
    kind = await syncReceiptDocumentKind(session.userId!, id, documentType);
  } else {
    kind = await syncReceiptDocumentKind(session.userId!, id, null).catch((error) => {
      console.warn(`Receipt ${id} was not filed as an ostolasku after an edit:`, error);
      return null;
    });
  }

  await runMatching(session.userId!).catch((error) =>
    console.error("Matching after receipt edit failed:", error)
  );
  // A kuitti just marked as a bill may already have its payment in the bank (W27).
  if (kind?.action === "filed" || kind?.action === "reopened") {
    await matchPurchasePaymentsFromBank(session.userId!).catch((error) =>
      console.error("Purchase payment matching after receipt edit failed:", error)
    );
  }
  const { totalAmountCents, originalAmountCents, ...safe } = receipt;
  return noStoreJson({
    ok: true,
    receipt: {
      ...safe,
      totalAmount: totalAmountCents == null ? null : centsToEuros(totalAmountCents),
      originalAmount: originalAmountCents == null ? null : centsToEuros(originalAmountCents),
    },
    purchaseInvoiceAction: kind?.action ?? "none",
    purchaseInvoiceSkipped: kind?.skipped ?? null,
  });
});

export const DELETE = withErrorHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError("Ei kirjautunut");
  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;

  const { id } = await params;
  const existing = await findOwnedReceipt(id, session.userId!);
  if (!existing) return noStoreJson({ error: "Kuittia ei löytynyt" }, { status: 404 });
  // Deleting a receipt changes a filed return exactly as much as editing one.
  await assertPeriodOpen(session.userId!, [existing.date]);
  // A bill filed from this receipt must not outlive it as an open payable. One
  // with payments or in a closed month is real bookkeeping and stays.
  await syncReceiptDocumentKind(session.userId!, id, "receipt").catch((error) => {
    if (error instanceof AppError && (error.code === "INVOICE_HAS_PAYMENTS" || error.code === "PERIOD_LOCKED")) {
      console.warn(`Deleted receipt ${id} leaves its ostolasku:`, error.message);
      return null;
    }
    throw error;
  });

  await prisma.$transaction(async (db) => {
    await db.transaction.updateMany({
      where: {
        statement: { userId: session.userId! },
        OR: [{ receiptId: id }, { suggestedReceiptId: id }],
      },
      data: {
        receiptId: null,
        suggestedReceiptId: null,
        matchStatus: "unmatched",
        matchScore: null,
        matchReasons: null,
      },
    });
    await dismissIncomeDraft(db, session.userId!, existing);
    await db.receipt.delete({ where: { id } });
    if (existing.uploadId) await db.upload.deleteMany({ where: { id: existing.uploadId, userId: session.userId! } });
  });

  await removeUserUpload(session.userId!, existing.filePath, true).catch((error) =>
    console.error("Receipt file cleanup failed:", error)
  );
  return noStoreJson({ ok: true });
});
