/**
 * The offline receipt-photo inbox: POST /api/receipts/inbox. Called by the
 * mobile app's IndexedDB queue once connectivity is back, one item at a
 * time, with the queue item id as the Idempotency-Key. Unlike
 * POST /api/receipts there is no editor session on the other end - a
 * successful capture always becomes a pending "app_capture" Receipt, never
 * just a staged upload waiting for the user to confirm it.
 */
import { NextRequest } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "./db";
import { requireSession } from "./session";
import { enqueueDocumentAnalysis } from "./document-jobs";
import { consumeRateLimit } from "./rate-limit";
import {
  MAX_RECEIPT_BYTES,
  UploadValidationError,
  removeUserUpload,
  safeOriginalName,
  sha256,
  validateUploadBuffer,
  writePrivateUpload,
} from "./storage";
import {
  STAGING_TTL_MS,
  discardStagedUpload,
  extractedFromStagedUpload,
  findReceiptIdForUpload,
  findReusableStagedUpload,
  receiptFieldsFromExtraction,
  wantsAiUpgrade,
  createPendingInboxReceipt,
  type StagedUploadRow,
} from "./receipt-staging";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "./http-security";
import { parseBusinessDetails, generateProfileSummary } from "./onboarding";

function parseCapturedAt(raw: FormDataEntryValue | null): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

async function queueFromStagedUpload(
  userId: string,
  upload: StagedUploadRow,
  originalName: string,
  mimeType: string,
  capturedAt: string,
  profileContext: string,
  vendorPriors: string
) {
  await prisma.upload.update({
    where: { id: upload.id },
    data: { originalName, expiresAt: new Date(Date.now() + STAGING_TTL_MS) },
  });

  if (upload.extractedJson && !wantsAiUpgrade(upload)) {
    // Already extracted (staged earlier by the interactive upload, or by a
    // previous inbox attempt that failed to send the response). Skip the
    // job entirely - the pending receipt is created right now.
    const extracted = extractedFromStagedUpload(upload);
    const job = await prisma.$transaction(async (tx) => {
      const created = await tx.backgroundJob.create({
        data: {
          userId,
          kind: "document_analysis",
          status: "done",
          title: `Kuitin analysointi: ${originalName}`.slice(0, 180),
          progressLabel: "Valmis",
          resourceType: "upload",
          resourceId: upload.id,
          startedAt: new Date(),
          finishedAt: new Date(),
          payload: JSON.stringify({
            uploadId: upload.id,
            mimeType,
            storageKey: upload.storageKey,
            originalName,
            profileContext: "",
            vendorPriors: "",
            extracted,
            inbox: { capturedAt },
          }),
        },
        select: { id: true, status: true },
      });
      await createPendingInboxReceipt(tx, {
        userId,
        uploadId: upload.id,
        storageKey: upload.storageKey,
        fileName: originalName,
        fields: receiptFieldsFromExtraction(extracted, new Date(capturedAt)),
      });
      return created;
    });
    return noStoreJson({ status: "queued", jobId: job.id, uploadId: upload.id }, { status: 201 });
  }

  const job = await enqueueDocumentAnalysis({
    userId,
    uploadId: upload.id,
    mimeType,
    storageKey: upload.storageKey,
    originalName,
    profileContext,
    vendorPriors,
    inbox: { capturedAt },
  });
  return noStoreJson({ status: "queued", jobId: job.id, uploadId: upload.id }, { status: 201 });
}

export async function handleReceiptInboxUpload(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return noStoreJson({ error: "Ei kirjautunut" }, { status: 401 });

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req, MAX_RECEIPT_BYTES + 1024 * 1024);
  if (oversized) return oversized;

  const idempotencyKey = req.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) {
    return noStoreJson({ error: "Idempotency-Key puuttuu" }, { status: 400 });
  }

  // Same bucket as POST /api/receipts: one owner uploading from the app and
  // from the web at once still shares one limit.
  const rate = consumeRateLimit(`receipt-upload:${session.userId}`, 20, 10 * 60_000);
  if (!rate.allowed) {
    return noStoreJson(
      { error: "Liian monta tiedostoa. Yritä myöhemmin uudelleen." },
      { status: 429, headers: { "Retry-After": String(rate.retryAfterSeconds) } }
    );
  }

  let storageKey: string | null = null;
  let uploadId: string | null = null;
  let checksum: string | null = null;
  let capturedAt: string | null = null;

  const user = await prisma.user.findUnique({
    where: { id: session.userId! },
    select: { businessDetails: true },
  });
  const profile = parseBusinessDetails(user?.businessDetails);
  const profileContext = generateProfileSummary(profile);

  let vendorPriors = "";
  try {
    const { getTopVendorsForAiPrompt } = await import("./vendor-intelligence");
    vendorPriors = await getTopVendorsForAiPrompt(session.userId!);
  } catch (e) {
    console.error("Failed to fetch vendor priors", e);
  }

  try {
    const formData = await req.formData();
    const candidate = formData.get("file");
    if (!(candidate instanceof File)) {
      return noStoreJson({ error: "Tiedosto puuttuu" }, { status: 400 });
    }
    capturedAt = parseCapturedAt(formData.get("capturedAt"));
    if (!capturedAt) {
      return noStoreJson({ error: "Kuvausaika puuttuu tai on virheellinen" }, { status: 400 });
    }

    const originalName = safeOriginalName(candidate.name);
    const buffer = Buffer.from(await candidate.arrayBuffer());
    const detected = validateUploadBuffer(buffer, originalName, "receipt");
    checksum = sha256(buffer);

    const existing = await findReusableStagedUpload(session.userId!, checksum);
    if (existing?.claimedAt) {
      const receiptId = await findReceiptIdForUpload(session.userId!, existing.id);
      return noStoreJson({ status: "duplicate", receiptId });
    }

    if (existing && existing.expiresAt <= new Date()) {
      await discardStagedUpload(session.userId!, existing);
    } else if (existing) {
      return queueFromStagedUpload(
        session.userId!,
        existing,
        originalName,
        detected.mimeType,
        capturedAt,
        profileContext,
        vendorPriors
      );
    }

    ({ storageKey } = await writePrivateUpload(session.userId!, detected.extension, buffer));
    const upload = await prisma.upload.create({
      data: {
        userId: session.userId!,
        purpose: "receipt",
        storageKey,
        originalName,
        mimeType: detected.mimeType,
        sizeBytes: buffer.length,
        sha256: checksum,
        expiresAt: new Date(Date.now() + STAGING_TTL_MS),
      },
    });
    uploadId = upload.id;

    return queueFromStagedUpload(
      session.userId!,
      {
        id: upload.id,
        storageKey,
        originalName,
        mimeType: detected.mimeType,
        extractedJson: null,
        extractionSource: null,
        confidence: null,
        rawText: null,
        claimedAt: null,
        expiresAt: upload.expiresAt,
      },
      originalName,
      detected.mimeType,
      capturedAt,
      profileContext,
      vendorPriors
    );
  } catch (error) {
    if (uploadId) await prisma.upload.deleteMany({ where: { id: uploadId, claimedAt: null } }).catch(() => {});
    if (storageKey) await removeUserUpload(session.userId!, storageKey).catch(() => {});
    if (error instanceof UploadValidationError) {
      return noStoreJson({ error: error.message }, { status: error.status });
    }
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002" &&
      checksum &&
      capturedAt
    ) {
      const raced = await findReusableStagedUpload(session.userId!, checksum);
      if (raced && !raced.claimedAt && raced.expiresAt > new Date()) {
        return queueFromStagedUpload(
          session.userId!,
          raced,
          raced.originalName,
          raced.mimeType,
          capturedAt,
          profileContext,
          vendorPriors
        );
      }
    }
    console.error("Receipt inbox upload error:", error);
    return noStoreJson({ error: "Tiedoston käsittely epäonnistui" }, { status: 500 });
  }
}
