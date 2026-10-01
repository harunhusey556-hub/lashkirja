import { randomUUID } from "crypto";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "./db";
import {
  extractReceipt,
  isUnreadableDocumentError,
  ReceiptExtractionError,
  unreadableExtraction,
  type ExtractedReceipt,
} from "./ai";
import { ensureReceiptPreviewImage } from "./preview";
import { resolveUserUploadPath } from "./storage";
import { RECEIPT_PHASE } from "./screen-state";
import { findActiveVendorRule } from "./vendor-rules";
import { isStuckRunning, runAfterResponse } from "./job-tracker";
import { noteJobFailure } from "./observe";
import {
  createPendingInboxReceipt,
  receiptFieldsFromExtraction,
  unreadableReceiptFields,
} from "./receipt-staging";

type Extractor = typeof extractReceipt;

let extractor: Extractor = extractReceipt;

/** Tests replace OCR so a job can finish without Tesseract or a cloud model. */
export function setDocumentExtractorForTests(fn: Extractor | null): void {
  extractor = fn ?? extractReceipt;
}

interface DocumentJobPayload {
  uploadId: string;
  mimeType: string;
  storageKey: string;
  originalName: string;
  profileContext: string;
  vendorPriors: string;
  extracted?: ExtractedReceipt;
  appliedRule?: { vendor: string; category: string } | null;
  /** Set for a job started from the offline receipt inbox: on completion or
   * failure a pending "app_capture" receipt is created so the photo is never
   * lost, with no editor session in between. */
  inbox?: { capturedAt: string };
}

function parsePayload(raw: string | null): DocumentJobPayload | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as DocumentJobPayload;
    if (!value.uploadId || !value.storageKey) return null;
    return value;
  } catch {
    return null;
  }
}

async function persistExtraction(
  tx: Prisma.TransactionClient,
  uploadId: string,
  extracted: ExtractedReceipt
) {
  const trustedRawText =
    typeof extracted.rawText === "string" ? extracted.rawText.slice(0, 100_000) : null;
  await tx.upload.update({
    where: { id: uploadId },
    data: {
      extractedJson: JSON.stringify({
        vendor: extracted.vendor,
        date: extracted.date,
        totalAmount: extracted.totalAmount,
        vatDetails: extracted.vatDetails,
        category: extracted.category,
        notes: extracted.notes,
        type: extracted.type,
        reference: extracted.reference,
        invoiceNumber: extracted.invoiceNumber,
      }),
      // An unreadable file is typed in by hand: its receipt is "manual", not "ocr".
      extractionSource: extracted.unreadable ? "manual" : extracted.source === "ai" ? "ai" : "ocr",
      confidence: Number.isFinite(extracted.confidence)
        ? Math.min(1, Math.max(0, extracted.confidence))
        : null,
      rawText: trustedRawText,
    },
  });
}

export async function enqueueDocumentAnalysis(input: {
  userId: string;
  uploadId: string;
  mimeType: string;
  storageKey: string;
  originalName: string;
  profileContext: string;
  vendorPriors: string;
  inbox?: { capturedAt: string };
}): Promise<{ id: string; status: string }> {
  const existing = await prisma.backgroundJob.findFirst({
    where: {
      userId: input.userId,
      kind: "document_analysis",
      resourceType: "upload",
      resourceId: input.uploadId,
      status: { in: ["pending", "running"] },
    },
    select: { id: true, status: true },
  });
  if (existing) return existing;

  const payload: DocumentJobPayload = {
    uploadId: input.uploadId,
    mimeType: input.mimeType,
    storageKey: input.storageKey,
    originalName: input.originalName,
    profileContext: input.profileContext,
    vendorPriors: input.vendorPriors,
    inbox: input.inbox,
  };
  const job = await prisma.backgroundJob.create({
    data: {
      userId: input.userId,
      kind: "document_analysis",
      status: "pending",
      title: `Kuitin analysointi: ${input.originalName}`.slice(0, 180),
      progressLabel: "Jonossa",
      resourceType: "upload",
      resourceId: input.uploadId,
      payload: JSON.stringify(payload),
    },
    select: { id: true, status: true },
  });
  runAfterResponse(() => processDocumentJob(job.id));
  return job;
}

export async function processDocumentJob(jobId: string): Promise<void> {
  const job = await prisma.backgroundJob.findUnique({ where: { id: jobId } });
  if (!job || job.kind !== "document_analysis") return;
  if (job.status === "done" || job.status === "cancelled" || job.status === "failed") return;
  if (job.status === "running") {
    if (!isStuckRunning(job.startedAt)) return;
    const reset = await prisma.backgroundJob.updateMany({
      where: { id: jobId, status: "running", startedAt: job.startedAt },
      data: { status: "pending", attemptToken: null, progressLabel: "Jonossa" },
    });
    if (reset.count === 0) return;
  }

  const attemptToken = randomUUID();
  const claimed = await prisma.backgroundJob.updateMany({
    where: { id: jobId, status: "pending" },
    data: {
      status: "running",
      attemptToken,
      startedAt: new Date(),
      finishedAt: null,
      error: null,
      progressLabel: RECEIPT_PHASE.process,
    },
  });
  if (claimed.count === 0) return;

  const payload = parsePayload(job.payload);
  if (!payload) {
    noteJobFailure(job.kind, "Työn tiedot puuttuvat");
    await prisma.backgroundJob.updateMany({
      where: { id: jobId, status: "running", attemptToken },
      data: {
        status: "failed",
        finishedAt: new Date(),
        error: "Työn tiedot puuttuvat",
        progressLabel: "Epäonnistui",
      },
    });
    return;
  }

  try {
    const absolutePath = resolveUserUploadPath(job.userId, payload.storageKey);
    let extracted: ExtractedReceipt;
    try {
      extracted = await extractor(
        absolutePath,
        payload.mimeType,
        payload.profileContext,
        payload.vendorPriors
      );
    } catch (extractionError) {
      // F04: nothing readable (no OCR on this machine) finishes the job like any other,
      // with empty fields and the file attached, so the user types the receipt in.
      // Only a genuinely broken file or a failed call stays a failure.
      if (!isUnreadableDocumentError(extractionError)) throw extractionError;
      extracted = unreadableExtraction();
    }
    await ensureReceiptPreviewImage(absolutePath, payload.mimeType).catch((error) =>
      console.warn("Preview generation failed:", error)
    );

    let appliedRule: { vendor: string; category: string; previous: string | null } | null = null;
    if (extracted.vendor) {
      const rule = await findActiveVendorRule(job.userId, extracted.vendor);
      if (rule?.active && rule.category !== extracted.category) {
        const previous = extracted.category;
        extracted = { ...extracted, category: rule.category };
        appliedRule = { vendor: rule.vendor, category: rule.category, previous };
      }
    }

    const stored: DocumentJobPayload = {
      ...payload,
      profileContext: "",
      vendorPriors: "",
      extracted,
      appliedRule,
    };
    await prisma.$transaction(async (tx) => {
      const won = await tx.backgroundJob.updateMany({
        where: { id: jobId, status: "running", attemptToken },
        data: {
          status: "done",
          finishedAt: new Date(),
          error: null,
          progressLabel: RECEIPT_PHASE.review,
          payload: JSON.stringify(stored),
        },
      });
      if (won.count === 0) return;
      await persistExtraction(tx, payload.uploadId, extracted);
      if (appliedRule && extracted.vendor) {
        await tx.automationEvent.create({
          data: {
            userId: job.userId,
            kind: "category",
            resourceType: "upload",
            resourceId: payload.uploadId,
            previousValue: appliedRule.previous,
            newValue: appliedRule.category,
            reason: "käyttäjän sääntö",
          },
        });
      }
      if (payload.inbox) {
        await createPendingInboxReceipt(tx, {
          userId: job.userId,
          uploadId: payload.uploadId,
          storageKey: payload.storageKey,
          fileName: payload.originalName,
          fields: receiptFieldsFromExtraction(extracted, new Date(payload.inbox.capturedAt)),
        });
      }
    });
  } catch (error) {
    const message =
      error instanceof ReceiptExtractionError
        ? error.message
        : "Tiedoston käsittely epäonnistui";
    noteJobFailure(job.kind, message);
    // Final review M2: this used to be one transaction with the fallback
    // receipt insert below. createPendingInboxReceipt can throw - P2002 on
    // Receipt.uploadId when the same photo was already saved from the web
    // editor or by a concurrent inbox retry (the success path hits the same
    // race), or a missing-row/FK error once the staging cleanup has deleted
    // the Upload row after 24 hours. When it did, the whole transaction
    // rolled back, so the "failed" status update above was undone too, and
    // the job stayed "running" until isStuckRunning() reset it - re-running
    // (and re-paying for) the same extraction forever. Marking the job
    // failed is its own statement first, unconditionally; the fallback
    // receipt is then best-effort and never re-opens the job on failure.
    const failed = await prisma.backgroundJob.updateMany({
      where: { id: jobId, status: "running", attemptToken },
      data: {
        status: "failed",
        finishedAt: new Date(),
        error: message.slice(0, 300),
        progressLabel: "Epäonnistui",
      },
    });
    if (failed.count === 0) return;
    // No photo is ever silently lost: even a failed extraction becomes a
    // pending receipt the owner can fill in by hand - but only best effort:
    // the job's own "failed" status above already landed regardless.
    if (payload.inbox) {
      try {
        await prisma.$transaction((tx) =>
          createPendingInboxReceipt(tx, {
            userId: job.userId,
            uploadId: payload.uploadId,
            storageKey: payload.storageKey,
            fileName: payload.originalName,
            fields: unreadableReceiptFields(new Date(payload.inbox!.capturedAt)),
          })
        );
      } catch (fallbackError) {
        const alreadyHandled =
          fallbackError instanceof Prisma.PrismaClientKnownRequestError &&
          (fallbackError.code === "P2002" || fallbackError.code === "P2025");
        if (!alreadyHandled) {
          console.error("Inbox fallback receipt failed:", fallbackError);
        }
      }
    }
  }
}

export function extractedFromJobPayload(raw: string | null): ExtractedReceipt | null {
  const payload = parsePayload(raw);
  return payload?.extracted ?? null;
}

export async function drainPendingDocumentJobs(limit = 5): Promise<number> {
  const stuckBefore = new Date(Date.now() - 10 * 60 * 1000);
  await prisma.backgroundJob.updateMany({
    where: {
      kind: "document_analysis",
      status: "running",
      OR: [{ startedAt: null }, { startedAt: { lt: stuckBefore } }],
    },
    data: { status: "pending", attemptToken: null, progressLabel: "Jonossa" },
  });
  const jobs = await prisma.backgroundJob.findMany({
    where: { kind: "document_analysis", status: "pending" },
    orderBy: { createdAt: "asc" },
    take: limit,
    select: { id: true },
  });
  for (const job of jobs) {
    await processDocumentJob(job.id);
  }
  return jobs.length;
}
