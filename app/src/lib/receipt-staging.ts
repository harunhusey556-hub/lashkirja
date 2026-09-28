/**
 * Staging helpers shared by every path that turns an uploaded file into a
 * Receipt: the interactive upload (`POST /api/receipts`) and the offline
 * photo inbox (`POST /api/receipts/inbox`). Kept dependency-free of
 * document-jobs.ts so both that module and the two routes can import from
 * here without a cycle.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "./db";
import type { ExtractedReceipt } from "./ai";
import { removeUserUpload } from "./storage";

export const STAGING_TTL_MS = 24 * 60 * 60 * 1000;
/** How long an inbox-claimed upload's file is kept after it becomes a receipt. */
export const INBOX_UPLOAD_RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
export const INBOX_UNREADABLE_NOTE = "Tietoja ei saatu luettua kuvasta. Täydennä käsin.";

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
>;

/** Same field mapping mail-sync.ts uses for an email-imported receipt
 * (src/lib/mail-sync.ts:212-231), reused here for an app-captured one. */
export function receiptFieldsFromExtraction(
  extracted: ExtractedReceipt,
  fallbackDate: Date
): PendingReceiptFields {
  return {
    vendor: extracted.vendor,
    date: extracted.date ? new Date(extracted.date) : fallbackDate,
    totalAmountCents: extracted.totalAmount != null ? Math.round(extracted.totalAmount * 100) : null,
    vatDetails: extracted.vatDetails.length ? JSON.stringify(extracted.vatDetails) : null,
    category: extracted.category,
    notes: extracted.notes,
    reference: extracted.reference,
    invoiceNumber: extracted.invoiceNumber,
    type: extracted.type,
    confidence: extracted.confidence,
    rawText: extracted.rawText,
  };
}

/** Nothing could be read from the photo: empty amounts, a Finnish note
 * asking the owner to fill it in by hand, so the capture is never lost. */
export function unreadableReceiptFields(fallbackDate: Date): PendingReceiptFields {
  return {
    vendor: null,
    date: fallbackDate,
    totalAmountCents: null,
    vatDetails: null,
    category: null,
    notes: INBOX_UNREADABLE_NOTE,
    reference: null,
    invoiceNumber: null,
    type: "meno",
    confidence: null,
    rawText: null,
  };
}

/** Creates the pending "app_capture" receipt and claims its upload, inside
 * the caller's transaction. Used both when a job finishes (document-jobs.ts)
 * and when a re-submitted photo's extraction is already on file
 * (receipt-inbox.ts). */
export async function createPendingInboxReceipt(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    uploadId: string;
    storageKey: string;
    fileName: string;
    fields: PendingReceiptFields;
  }
): Promise<void> {
  await tx.receipt.create({
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
  await tx.upload.update({
    where: { id: input.uploadId },
    data: {
      claimedAt: new Date(),
      expiresAt: new Date(Date.now() + INBOX_UPLOAD_RETENTION_MS),
    },
  });
}
