import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { enqueueDocumentAnalysis } from "@/lib/document-jobs";
import { centsToEuros } from "@/lib/money";
import { consumeRateLimit } from "@/lib/rate-limit";
import {
  MAX_RECEIPT_BYTES,
  UploadValidationError,
  removeUserUpload,
  safeOriginalName,
  sha256,
  validateUploadBuffer,
  writePrivateUpload,
} from "@/lib/storage";
import {
  STAGING_TTL_MS,
  discardStagedUpload,
  extractedFromStagedUpload,
  findReceiptIdForUpload,
  findReusableStagedUpload,
  wantsAiUpgrade,
  type StagedUploadRow,
} from "@/lib/receipt-staging";
import { buildReceiptMatchViews } from "@/lib/matching";
import { buildReceiptWhere, ReceiptFilterError } from "@/lib/receipt-filters";
import { noteRequest, timeDb } from "@/lib/observe";
import {
  noStoreJson,
  rejectCrossSite,
  rejectOversizedContentLength,
} from "@/lib/http-security";
import { parseBusinessDetails, generateProfileSummary } from "@/lib/onboarding";

const MAX_LIST_ROWS = 200;
const MAX_LIST_OFFSET = 100_000;

function parseListOffset(raw: string | null): number | null {
  if (raw == null || raw === "") return 0;
  if (!/^\d{1,6}$/.test(raw)) return null;
  const offset = Number(raw);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_LIST_OFFSET) return null;
  return offset;
}

async function acceptStagedUpload(
  userId: string,
  upload: StagedUploadRow,
  originalName: string,
  mimeType: string,
  profileContext: string,
  vendorPriors: string
) {
  await prisma.upload.update({
    where: { id: upload.id },
    data: {
      originalName,
      expiresAt: new Date(Date.now() + STAGING_TTL_MS),
    },
  });

  if (upload.extractedJson && !wantsAiUpgrade(upload)) {
    return noStoreJson({
      extracted: extractedFromStagedUpload(upload),
      uploadId: upload.id,
      filePath: upload.storageKey,
      originalName,
      status: "done",
    });
  }

  const job = await enqueueDocumentAnalysis({
    userId,
    uploadId: upload.id,
    mimeType,
    storageKey: upload.storageKey,
    originalName,
    profileContext,
    vendorPriors,
  });
  return noStoreJson({
    jobId: job.id,
    status: job.status,
    uploadId: upload.id,
    filePath: upload.storageKey,
    originalName,
  });
}

export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return noStoreJson({ error: "Ei kirjautunut" }, { status: 401 });

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req, MAX_RECEIPT_BYTES + 1024 * 1024);
  if (oversized) return oversized;
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
  
  const user = await prisma.user.findUnique({ where: { id: session.userId! }, select: { businessDetails: true } });
  const profile = parseBusinessDetails(user?.businessDetails);
  const profileContext = generateProfileSummary(profile);

  let vendorPriors = "";
  try {
    const { getTopVendorsForAiPrompt } = await import("@/lib/vendor-intelligence");
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

    const originalName = safeOriginalName(candidate.name);
    const buffer = Buffer.from(await candidate.arrayBuffer());
    const detected = validateUploadBuffer(buffer, originalName, "receipt");
    checksum = sha256(buffer);

    const existing = await findReusableStagedUpload(session.userId!, checksum);
    if (existing?.claimedAt) {
      const receiptId = await findReceiptIdForUpload(session.userId!, existing.id);
      return noStoreJson(
        {
          error: "Tämä kuitti on jo tallennettu",
          code: "DUPLICATE_DOCUMENT",
          receiptId,
        },
        { status: 409 }
      );
    }
    
    if (existing && existing.expiresAt <= new Date()) {
      await discardStagedUpload(session.userId!, existing);
    } else if (existing) {
      return acceptStagedUpload(
        session.userId!,
        existing,
        originalName,
        detected.mimeType,
        profileContext,
        vendorPriors
      );
    }

    ({ storageKey } = await writePrivateUpload(
      session.userId!,
      detected.extension,
      buffer
    ));
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

    return acceptStagedUpload(
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
      checksum
    ) {
      const raced = await findReusableStagedUpload(session.userId!, checksum);
      if (raced && !raced.claimedAt && raced.expiresAt > new Date()) {
        return acceptStagedUpload(
          session.userId!,
          raced,
          raced.originalName,
          raced.mimeType,
          profileContext,
          vendorPriors
        );
      }
    }
    console.error("Receipt upload error:", error);
    return noStoreJson({ error: "Tiedoston käsittely epäonnistui" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const started = Date.now();
  const session = await requireSession(req);
  if (!session) return noStoreJson({ error: "Ei kirjautunut" }, { status: 401 });

  const url = new URL(req.url);
  const offset = parseListOffset(url.searchParams.get("offset"));
  if (offset === null) return noStoreJson({ error: "Virheellinen sivutus" }, { status: 400 });
  const month = url.searchParams.get("month");
  const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
  const type = url.searchParams.get("type");
  const category = url.searchParams.get("category")?.slice(0, 100);
  const source = url.searchParams.get("source");
  const minAmount = url.searchParams.get("minAmount");
  const maxAmount = url.searchParams.get("maxAmount");
  const sort = url.searchParams.get("sort") || "date_desc";
  const reviewStatus = url.searchParams.get("reviewStatus");

  let where: Prisma.ReceiptWhereInput;
  try {
    where = buildReceiptWhere(session.userId!, { reviewStatus, month, q, category, source, minAmount, maxAmount });
  } catch (error) {
    if (error instanceof ReceiptFilterError) return noStoreJson({ error: error.message }, { status: 400 });
    throw error;
  }

  if (type === "meno" || type === "tulo") where.type = type;

  const linkedStatus = url.searchParams.get("linkedStatus");
  if (linkedStatus === "linked") where.linkedTransaction = { isNot: null };
  if (linkedStatus === "unlinked") where.linkedTransaction = null;

  let orderBy: Prisma.ReceiptOrderByWithRelationInput = { date: "desc" };
  if (sort === "date_asc") orderBy = { date: "asc" };
  else if (sort === "amount_desc") orderBy = { totalAmountCents: "desc" };
  else if (sort === "amount_asc") orderBy = { totalAmountCents: "asc" };
  else if (sort === "created_desc") orderBy = { createdAt: "desc" };

  const [receipts, count] = await timeDb("Receipt", "list", () => Promise.all([
    prisma.receipt.findMany({
      where,
      orderBy,
      skip: offset,
      take: MAX_LIST_ROWS,
      select: {
        id: true,
        vendor: true,
        date: true,
        totalAmountCents: true,
        category: true,
        type: true,
        reference: true,
        invoiceNumber: true,
        fileName: true,
        source: true,
        confidence: true,
        createdAt: true,
        updatedAt: true,
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
    }),
    prisma.receipt.count({ where }),
  ]));

  const matchViews = await buildReceiptMatchViews(
    session.userId!,
    receipts.map(({ totalAmountCents, linkedTransaction, ...receipt }) => ({
      ...receipt,
      totalAmount: totalAmountCents == null ? null : centsToEuros(totalAmountCents),
      linkedTransaction,
    })),
    { candidates: false }
  );

  const response = noStoreJson({
    receipts: receipts.map(({ totalAmountCents, linkedTransaction, ...receipt }) => {
      const match = matchViews.get(receipt.id);
      return {
        ...receipt,
        totalAmount: totalAmountCents == null ? null : centsToEuros(totalAmountCents),
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
          matchCandidates: [],
          candidatesDeferred: (match?.status ?? "unlinked") === "unlinked",
        },
      };
    }),
    count,
    truncated: count > offset + receipts.length,
  });
  noteRequest({ route: "GET /api/receipts", status: 200, durationMs: Date.now() - started });
  return response;
}
