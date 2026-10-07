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
import { consumeRateLimit, RECEIPT_UPLOADS_PER_WINDOW } from "./rate-limit";
import {
  MAX_RECEIPT_REQUEST_BYTES,
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

/** A small allowance for the capturing device's clock running fast; anything
 * further into the future than this is treated as invalid, not clamped, so
 * a bogus date never silently becomes "now". */
const CAPTURED_AT_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
/** The offline queue can hold an item for a long time, but not a year -
 * final review M4: an unranged capturedAt (e.g. year 9999 or 1970, from a
 * device with no clock set yet) becomes the receipt's date whenever
 * extraction finds none. Reject rather than clamp: a caller sending a
 * genuinely bad date should get the same "missing or invalid" 400 as a
 * malformed string, not a silently substituted value. */
const CAPTURED_AT_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

function parseCapturedAt(raw: FormDataEntryValue | null): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const date = new Date(raw);
  const time = date.getTime();
  if (Number.isNaN(time)) return null;
  const now = Date.now();
  if (time > now + CAPTURED_AT_MAX_FUTURE_SKEW_MS) return null;
  if (time < now - CAPTURED_AT_MAX_AGE_MS) return null;
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
          title: "Kuitin lukeminen",
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

/**
 * Response status codes from this route, documented once here (final review
 * I2 asked for this to be "clean and documented" because the client-side
 * offline queue makes any 4xx terminal - a permanent `failed` item - and
 * retries anything else):
 *
 * - 200/201: queued, duplicate, etc. - see the individual return points.
 * - 400: Idempotency-Key missing; capturedAt missing, unparseable, or out
 *   of range (see CAPTURED_AT_MAX_*); the multipart body itself could not
 *   be parsed (a genuinely malformed request, not merely oversized - a
 *   truncated-by-size body is caught by 413 below instead).
 * - 401: not signed in.
 * - 403: cross-site request (rejectCrossSite).
 * - 413: Content-Length exceeds MAX_RECEIPT_REQUEST_BYTES, or the decoded
 *   file itself exceeds MAX_RECEIPT_BYTES (UploadValidationError).
 * - 415: file content does not match a supported receipt type, or its
 *   extension does not match its content (UploadValidationError).
 * - 429: rate limited.
 * - 5xx is never a *terminal* client outcome, so it must never be returned
 *   for a client mistake - only for a genuine server-side failure (a
 *   database error, disk full). If this route starts returning 500 for a
 *   large-but-legitimate photo, that's the truncation bug from I2, not a
 *   legitimate need for a new case here.
 */
export async function handleReceiptInboxUpload(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return noStoreJson({ error: "Ei kirjautunut" }, { status: 401 });

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req, MAX_RECEIPT_REQUEST_BYTES);
  if (oversized) return oversized;

  const idempotencyKey = req.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey) {
    return noStoreJson({ error: "Idempotency-Key puuttuu" }, { status: 400 });
  }

  // Same bucket as POST /api/receipts: one owner uploading from the app and
  // from the web at once still shares one limit.
  const rate = consumeRateLimit(`receipt-upload:${session.userId}`, RECEIPT_UPLOADS_PER_WINDOW, 10 * 60_000);
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

  // Parsing the multipart body is isolated from the rest of the work below:
  // a malformed body (a bad boundary, a body cut off mid-part - the shape a
  // truncated-by-size request used to take before I2's proxy fix) must
  // answer 400, never the generic 500 the outer catch below falls back to.
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (error) {
    console.error("Receipt inbox: could not parse multipart body:", error);
    return noStoreJson({ error: "Pyyntöä ei voitu käsitellä" }, { status: 400 });
  }

  try {
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
