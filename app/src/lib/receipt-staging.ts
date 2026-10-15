/**
 * Staging helpers shared by every path that turns an uploaded file into a
 * Receipt: the interactive upload (`POST /api/receipts`) and the offline
 * photo inbox (`POST /api/receipts/inbox`). Kept dependency-free of
 * document-jobs.ts so both that module and the two routes can import from
 * here without a cycle.
 */
import type { Prisma, Receipt } from "@/generated/prisma/client";
import { prisma } from "./db";
import { creditSigned, creditSignedVatLines, type DocumentType, type ExtractedReceipt } from "./ai";
import { removeUserUpload } from "./storage";
import { UNREADABLE_RECEIPT_NOTE } from "./receipt-unreadable";
import { foreignFieldsFromExtraction } from "./foreign-purchase";
import { fileReceiptAsPurchaseInvoice, matchPurchasePaymentsFromBank } from "./purchase-invoices";
import { helsinkiDayUtc } from "./validation";
import { AUTO_ACCEPT_COMPLETE_RECEIPTS, canAutoAccept } from "./auto-accept";
import { getLockedThrough, isDateLocked } from "./period-lock";
import { runMatching } from "./matching";

export const STAGING_TTL_MS = 24 * 60 * 60 * 1000;
/** How long an inbox-claimed upload's file is kept after it becomes a receipt. */
export const INBOX_UPLOAD_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
export const INBOX_UNREADABLE_NOTE = UNREADABLE_RECEIPT_NOTE;

export type StagedUploadRow = {
  id: string;
  storageKey: string;
  originalName: string;
  mimeType: string;
  extractedJson: string | null;
  extractionSource: string | null;
  confidence: number | null;
  rawText: string | null;
  claimedAt: Date | null;
  expiresAt: Date;
};

export function extractedFromStagedUpload(upload: StagedUploadRow): ExtractedReceipt {
  const base = upload.extractedJson
    ? (JSON.parse(upload.extractedJson) as Omit<
        ExtractedReceipt,
        "source" | "provenance" | "confidence" | "rawText"
      >)
    : {
        vendor: null,
        date: null,
        totalAmount: null,
        vatDetails: [],
        category: null,
        notes: null,
        type: "meno" as const,
        reference: null,
        invoiceNumber: null,
      };
  return {
    ...base,
    type: base.type === "tulo" ? "tulo" : "meno",
    source: upload.extractionSource === "ai" ? "ai" : "ocr",
    provenance: upload.extractionSource === "ai" ? "openai-compatible" : "local-ocr",
    confidence: upload.confidence ?? 0.25,
    rawText: upload.rawText ?? undefined,
    // A file nothing could be read from was stored as "manual" (document-jobs.ts persistExtraction).
    ...(upload.extractionSource === "manual" ? { unreadable: true } : {}),
  };
}

export function wantsAiUpgrade(upload: StagedUploadRow): boolean {
  return Boolean(
    upload.extractedJson &&
      upload.extractionSource !== "ai" &&
      (process.env.LLM_API_KEY || process.env.COPILOT_GITHUB_TOKEN)
  );
}

export async function findReusableStagedUpload(
  userId: string,
  checksum: string
): Promise<StagedUploadRow | null> {
  return prisma.upload.findFirst({
    where: { userId, purpose: "receipt", sha256: checksum },
    select: {
      id: true,
      storageKey: true,
      originalName: true,
      mimeType: true,
      extractedJson: true,
      extractionSource: true,
      confidence: true,
      rawText: true,
      claimedAt: true,
      expiresAt: true,
    },
  });
}

export async function discardStagedUpload(
  userId: string,
  upload: { id: string; storageKey: string }
): Promise<void> {
  await removeUserUpload(userId, upload.storageKey).catch(() => {});
  await prisma.upload.deleteMany({ where: { id: upload.id, userId, claimedAt: null } });
}

/** The receipt a previously claimed upload turned into, if any - used to
 * answer a duplicate submission with the receipt the user already has. */
export async function findReceiptIdForUpload(
  userId: string,
  uploadId: string
): Promise<string | null> {
  const receipt = await prisma.receipt.findFirst({
    where: { userId, uploadId },
    select: { id: true },
  });
  return receipt?.id ?? null;
}

type PendingReceiptFields = Pick<
  Prisma.ReceiptCreateInput,
  | "vendor"
  | "date"
  | "totalAmountCents"
  | "vatDetails"
  | "category"
  | "notes"
  | "reference"
  | "invoiceNumber"
  | "type"
  | "confidence"
  | "rawText"
  | "currency"
  | "vatTreatment"
  | "originalAmountCents"
>;

/** Same field mapping mail-sync.ts uses for an email-imported receipt
 * (src/lib/mail-sync.ts:212-231), reused here for an app-captured one. */
export function receiptFieldsFromExtraction(
  extracted: ExtractedReceipt,
  fallbackDate: Date
): PendingReceiptFields {
  // Nothing was read: the same empty receipt with the same note on every path.
  if (extracted.unreadable) return unreadableReceiptFields(fallbackDate);
  const credit = extracted.isCreditNote;
  const foreign = foreignFieldsFromExtraction(extracted);
  return {
    vendor: extracted.vendor,
    // The fallback is an instant (capture time); the receipt keeps the Helsinki day it fell on.
    date: extracted.date ? new Date(extracted.date) : helsinkiDayUtc(fallbackDate),
    totalAmountCents:
      extracted.totalAmount != null ? creditSigned(Math.round(extracted.totalAmount * 100), credit) : null,
    vatDetails: extracted.vatDetails.length
      ? JSON.stringify(creditSignedVatLines(extracted.vatDetails, credit))
      : null,
    category: extracted.category,
    notes: extracted.notes,
    reference: extracted.reference,
    invoiceNumber: extracted.invoiceNumber,
    type: extracted.type,
    confidence: extracted.confidence,
    rawText: extracted.rawText,
    ...foreign,
    originalAmountCents:
      foreign.originalAmountCents == null ? null : creditSigned(foreign.originalAmountCents, credit),
  };
}

/** Nothing could be read from the photo: empty amounts, a Finnish note
 * asking the owner to fill it in by hand, so the capture is never lost. */
export function unreadableReceiptFields(fallbackDate: Date): PendingReceiptFields {
  return {
    vendor: null,
    date: helsinkiDayUtc(fallbackDate),
    totalAmountCents: null,
    vatDetails: null,
    category: null,
    notes: INBOX_UNREADABLE_NOTE,
    reference: null,
    invoiceNumber: null,
    type: "meno",
    confidence: null,
    rawText: null,
    originalAmountCents: null,
  };
}

/** The kind of document a stored reading says an upload is: a bill the owner
 * owes ("invoice"), a mere receipt, or something not to be filed at all. */
export function storedDocumentKind(extractedJson: string | null): {
  documentType: DocumentType | null;
  dueDate: string | null;
  isCreditNote: boolean;
  creditsInvoiceNumber: string | null;
} {
  const none = { documentType: null, dueDate: null, isCreditNote: false, creditsInvoiceNumber: null };
  if (!extractedJson) return none;
  try {
    const read = JSON.parse(extractedJson) as {
      documentType?: DocumentType | null;
      dueDate?: string | null;
      isCreditNote?: boolean;
      creditsInvoiceNumber?: string | null;
    };
    return {
      documentType: read.documentType ?? null,
      dueDate: read.dueDate ?? null,
      isCreditNote: read.isCreditNote === true,
      creditsInvoiceNumber: typeof read.creditsInvoiceNumber === "string" ? read.creditsInvoiceNumber : null,
    };
  } catch {
    // An unreadable stored reading files nothing on its own.
    return none;
  }
}

/** Said on a look-alike that was kept anyway, so the review queue tells the two apart
 * (two identical Shell Polska rows waited side by side, 2026-10-15). */
export const DUPLICATE_NOTE = "Mahdollinen kaksoiskappale: samalla myyjällä, päivällä ja summalla on jo kuitti.";

export function withDuplicateNote(notes: string | null): string {
  return notes ? `${DUPLICATE_NOTE}\n${notes}` : DUPLICATE_NOTE;
}

/** A receipt the user already has with the same vendor, day and sum: the
 * duplicate signal the save route answers with 409 and auto-accept never
 * approves. `excludeId` leaves out the row being judged. */
export async function findLookAlikeReceipt(
  db: Prisma.TransactionClient | typeof prisma,
  userId: string,
  receipt: { vendor: string | null; date: Date | null; totalAmountCents: number | null },
  excludeId?: string
): Promise<{ id: string } | null> {
  if (!receipt.vendor || !receipt.date || receipt.totalAmountCents == null) return null;
  return db.receipt.findFirst({
    where: {
      userId,
      vendor: receipt.vendor,
      date: receipt.date,
      totalAmountCents: receipt.totalAmountCents,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true },
  });
}

/** W8 auto-accept on a row just created inside `db`'s transaction: judged as
 * stored (lib/auto-accept.ts), then approved or left pending in that same
 * transaction, so a crash can never leave it half approved. The one approval
 * step shared by POST /api/receipts/save (autoApprove) and the phone inbox. */
export async function settleAutoAccept(
  db: Prisma.TransactionClient,
  created: Receipt,
  signals: { documentType: DocumentType | null; duplicate: boolean; isCreditNote?: boolean }
): Promise<Receipt> {
  return db.receipt.update({
    where: { id: created.id },
    data: {
      reviewStatus: canAutoAccept({
        ...created,
        documentType: signals.documentType,
        duplicate: signals.duplicate,
        isCreditNote: signals.isCreditNote,
      })
        ? "approved"
        : "pending",
    },
  });
}

/** What follows a committed receipt save (W27): bank matching for the user,
 * and the purchase-payment matching when a bill was just filed, so a bank row
 * already carrying its viite pays the new ostolasku. Never fails the save. */
export async function matchAfterReceiptSave(userId: string, filedInvoice: boolean): Promise<void> {
  await runMatching(userId).catch((error) => console.error("Matching after receipt save failed:", error));
  if (filedInvoice) {
    await matchPurchasePaymentsFromBank(userId).catch((error) =>
      console.error("Purchase payment matching after receipt save failed:", error)
    );
  }
}

/** Whether the stored reading itself found a date; an inbox receipt without
 * one carries the capture day, which must not pass for a complete reading. */
function readingHasDate(extractedJson: string | null): boolean {
  if (!extractedJson) return false;
  try {
    return Boolean((JSON.parse(extractedJson) as { date?: unknown }).date);
  } catch {
    // An unreadable stored reading counts as no date: the receipt stays pending.
    return false;
  }
}

/** Creates the "app_capture" receipt and claims its upload, inside the
 * caller's transaction. Used both when a job finishes (document-jobs.ts) and
 * when a re-submitted photo's extraction is already on file
 * (receipt-inbox.ts). A complete reading is approved the way an upload saved
 * with autoApprove is (W31); anything else stays pending. When
 * `matchAfterSave` is set the caller runs matchAfterReceiptSave once the
 * transaction has committed, as the save route does. */
export async function createPendingInboxReceipt(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    uploadId: string;
    storageKey: string;
    fileName: string;
    fields: PendingReceiptFields;
  }
): Promise<{ receiptId: string; filedInvoice: boolean; matchAfterSave: boolean }> {
  let receipt = await tx.receipt.create({
    data: {
      userId: input.userId,
      uploadId: input.uploadId,
      filePath: input.storageKey,
      fileName: input.fileName,
      source: "app_capture",
      reviewStatus: "pending",
      ...input.fields,
    },
  });
  const upload = await tx.upload.update({
    where: { id: input.uploadId },
    data: {
      claimedAt: new Date(),
      expiresAt: new Date(Date.now() + INBOX_UPLOAD_RETENTION_MS),
    },
    select: { extractedJson: true },
  });
  const reading = storedDocumentKind(upload.extractedJson);
  // W31: phone captures get the upload's auto-accept. The save route asserts an
  // open period and refuses a look-alike before it creates; here nobody waits
  // for an answer, so a closed month or a look-alike simply stays pending.
  if (
    AUTO_ACCEPT_COMPLETE_RECEIPTS &&
    readingHasDate(upload.extractedJson) &&
    !isDateLocked(await getLockedThrough(input.userId, tx), receipt.date)
  ) {
    const lookAlike = await findLookAlikeReceipt(tx, input.userId, receipt, receipt.id);
    if (lookAlike) {
      receipt = await tx.receipt.update({ where: { id: receipt.id }, data: { notes: withDuplicateNote(receipt.notes) } });
    }
    receipt = await settleAutoAccept(tx, receipt, {
      documentType: reading.documentType,
      duplicate: lookAlike != null,
      isCreditNote: reading.isCreditNote,
    });
  }
  // A photographed bill becomes an ostolasku like a saved one (the reading is
  // on the upload by now). Best effort: a closed period or an incomplete
  // reading must never lose the capture itself. Idempotent per receipt, so an
  // approved bill is still filed exactly once.
  let filedInvoice = false;
  try {
    filedInvoice = (await fileReceiptAsPurchaseInvoice(input.userId, receipt, reading, tx)).created;
  } catch (error) {
    console.warn(`Inbox receipt ${receipt.id} was not filed as an ostolasku:`, error);
  }
  return { receiptId: receipt.id, filedInvoice, matchAfterSave: AUTO_ACCEPT_COMPLETE_RECEIPTS };
}
