import { prisma } from "./db";
import {
  extractReceipt,
  ReceiptExtractionError,
  type ExtractedReceipt,
} from "./ai";
import { ensureReceiptPreviewImage } from "./preview";
import { resolveUserUploadPath } from "./storage";
import { RECEIPT_PHASE } from "./screen-state";
import { findActiveVendorRule } from "./vendor-rules";
import { isStuckRunning, runAfterResponse } from "./job-tracker";

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

async function persistExtraction(uploadId: string, extracted: ExtractedReceipt) {
  const trustedRawText =
    typeof extracted.rawText === "string" ? extracted.rawText.slice(0, 100_000) : null;
  await prisma.upload.update({
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
      extractionSource: extracted.source === "ai" ? "ai" : "ocr",
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
      data: { status: "pending", progressLabel: "Jonossa" },
    });
    if (reset.count === 0) return;
  }

  const claimed = await prisma.backgroundJob.updateMany({
    where: { id: jobId, status: "pending" },
    data: {
      status: "running",
      startedAt: new Date(),
      finishedAt: null,
      error: null,
      progressLabel: RECEIPT_PHASE.process,
    },
  });
  if (claimed.count === 0) return;

  const payload = parsePayload(job.payload);
  if (!payload) {
    await prisma.backgroundJob.update({
      where: { id: jobId },
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
    let extracted = await extractor(
      absolutePath,
      payload.mimeType,
      payload.profileContext,
      payload.vendorPriors
    );
    await ensureReceiptPreviewImage(absolutePath, payload.mimeType).catch((error) =>
      console.warn("Preview generation failed:", error)
    );

    let appliedRule: { vendor: string; category: string } | null = null;
    if (extracted.vendor) {
      const rule = await findActiveVendorRule(job.userId, extracted.vendor);
      if (rule?.active && rule.category !== extracted.category) {
        const previous = extracted.category;
        extracted = { ...extracted, category: rule.category };
        appliedRule = { vendor: rule.vendor, category: rule.category };
        await prisma.automationEvent.create({
          data: {
            userId: job.userId,
            kind: "category",
            resourceType: "upload",
            resourceId: payload.uploadId,
            previousValue: previous,
            newValue: rule.category,
            reason: "käyttäjän sääntö",
          },
        });
      }
    }

    await persistExtraction(payload.uploadId, extracted);
    const stored: DocumentJobPayload = {
      ...payload,
      profileContext: "",
      vendorPriors: "",
      extracted,
      appliedRule,
    };
    await prisma.backgroundJob.updateMany({
      where: { id: jobId, status: "running" },
      data: {
        status: "done",
        finishedAt: new Date(),
        error: null,
        progressLabel: RECEIPT_PHASE.review,
        payload: JSON.stringify(stored),
      },
    });
  } catch (error) {
    const message =
      error instanceof ReceiptExtractionError
        ? error.message
        : "Tiedoston käsittely epäonnistui";
    await prisma.backgroundJob.updateMany({
      where: { id: jobId, status: "running" },
      data: {
        status: "failed",
        finishedAt: new Date(),
        error: message.slice(0, 300),
        progressLabel: "Epäonnistui",
      },
    });
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
    data: { status: "pending", progressLabel: "Jonossa" },
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
