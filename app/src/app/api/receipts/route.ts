import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { extractReceipt, ReceiptExtractionError, type ExtractedReceipt } from "@/lib/ai";
import { ensureReceiptPreviewImage } from "@/lib/preview";
import { centsToEuros, eurosToCents } from "@/lib/money";
import { consumeRateLimit } from "@/lib/rate-limit";
import {
  MAX_RECEIPT_BYTES,
  UploadValidationError,
  removeUserUpload,
  resolveUserUploadPath,
  safeOriginalName,
  sha256,
  validateUploadBuffer,
  writePrivateUpload,
} from "@/lib/storage";
import { monthBoundsUtc, monthSchema } from "@/lib/validation";
import { buildReceiptMatchViews } from "@/lib/matching";
import {
  noStoreJson,
  rejectCrossSite,
  rejectOversizedContentLength,
} from "@/lib/http-security";
import { parseBusinessDetails, generateProfileSummary } from "@/lib/onboarding";

const MAX_LIST_ROWS = 200;
const STAGING_TTL_MS = 24 * 60 * 60 * 1000;

type StagedUploadRow = {
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

function extractedFromStagedUpload(upload: StagedUploadRow): ExtractedReceipt {
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

async function persistExtraction(uploadId: string, extracted: ExtractedReceipt) {
  const trustedRawText =
    typeof extracted.rawText === "string"
      ? extracted.rawText.slice(0, 100_000)
      : null;
  const trustedSource = extracted.source === "ai" ? "ai" : "ocr";
  const trustedConfidence = Number.isFinite(extracted.confidence)
    ? Math.min(1, Math.max(0, extracted.confidence))
    : null;

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
      extractionSource: trustedSource,
      confidence: trustedConfidence,
      rawText: trustedRawText,
    },
  });
}

async function discardStagedUpload(userId: string, upload: { id: string; storageKey: string }) {
  await removeUserUpload(userId, upload.storageKey).catch(() => {});
  await prisma.upload.deleteMany({ where: { id: upload.id, userId, claimedAt: null } });
}

async function reuseStagedUpload(
  userId: string,
  upload: StagedUploadRow,
  originalName: string,
  mimeType: string,
  profileContext: string,
  vendorPriors: string
) {
  let extracted: ExtractedReceipt;
  const absolutePath = resolveUserUploadPath(userId, upload.storageKey);
  const shouldUpgradeToAi =
    upload.extractedJson &&
    upload.extractionSource !== "ai" &&
    Boolean(process.env.LLM_API_KEY || process.env.COPILOT_GITHUB_TOKEN);

  if (upload.extractedJson && !shouldUpgradeToAi) {
    extracted = extractedFromStagedUpload(upload);
  } else {
    extracted = await extractReceipt(absolutePath, mimeType, profileContext, vendorPriors);
    await persistExtraction(upload.id, extracted);
  }
  await ensureReceiptPreviewImage(absolutePath, mimeType).catch((err) =>
    console.warn("Preview generation failed:", err)
  );

  await prisma.upload.update({
    where: { id: upload.id },
    data: {
      originalName,
      expiresAt: new Date(Date.now() + STAGING_TTL_MS),
    },
  });

  return noStoreJson({
    extracted,
    uploadId: upload.id,
    filePath: upload.storageKey,
    originalName,
  });
}

async function findReusableStagedUpload(userId: string, checksum: string) {
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
  let absolutePath: string | null = null;
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
      return noStoreJson({ error: "Tämä kuitti on jo tallennettu" }, { status: 409 });
    }
    
    if (existing && existing.expiresAt <= new Date()) {
      await discardStagedUpload(session.userId!, existing);
    } else if (existing) {
      return reuseStagedUpload(
        session.userId!,
        existing,
        originalName,
        detected.mimeType,
        profileContext,
        vendorPriors
      );
    }

    ({ storageKey, absolutePath } = await writePrivateUpload(
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

    const extracted = await extractReceipt(absolutePath, detected.mimeType, profileContext, vendorPriors);
    await persistExtraction(upload.id, extracted);
    await ensureReceiptPreviewImage(absolutePath, detected.mimeType).catch((err) =>
      console.warn("Preview generation failed:", err)
    );

    return noStoreJson({
      extracted,
      uploadId: upload.id,
      // Kept temporarily for preview URL compatibility; save accepts uploadId only.
      filePath: storageKey,
      originalName,
    });
  } catch (error) {
    if (uploadId) await prisma.upload.deleteMany({ where: { id: uploadId } }).catch(() => {});
    if (storageKey) await removeUserUpload(session.userId!, storageKey).catch(() => {});
    if (error instanceof UploadValidationError) {
      return noStoreJson({ error: error.message }, { status: error.status });
    }
    if (error instanceof ReceiptExtractionError) {
      return noStoreJson({ error: error.message, code: error.code }, { status: 422 });
    }
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002" &&
      checksum
    ) {
      const raced = await findReusableStagedUpload(session.userId!, checksum);
      if (raced && !raced.claimedAt && raced.expiresAt > new Date()) {
        return reuseStagedUpload(
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
  const session = await requireSession(req);
  if (!session) return noStoreJson({ error: "Ei kirjautunut" }, { status: 401 });

  const url = new URL(req.url);
  const month = url.searchParams.get("month");
  const q = (url.searchParams.get("q") || "").trim().slice(0, 100);
  const type = url.searchParams.get("type");
  const category = url.searchParams.get("category")?.slice(0, 100);
  const source = url.searchParams.get("source");
  const minAmount = url.searchParams.get("minAmount");
  const maxAmount = url.searchParams.get("maxAmount");
  const sort = url.searchParams.get("sort") || "date_desc";
  const reviewStatus = url.searchParams.get("reviewStatus");
  const where: Prisma.ReceiptWhereInput = { userId: session.userId };

  if (reviewStatus === "pending") where.reviewStatus = "pending";
  else if (reviewStatus === "rejected") where.reviewStatus = "rejected";
  else if (reviewStatus === "all") {} // leave empty to fetch all
  else where.reviewStatus = "approved"; // Default to approved only

  if (month) {
    const parsedMonth = monthSchema.safeParse(month);
    if (!parsedMonth.success) return noStoreJson({ error: "Virheellinen kuukausi" }, { status: 400 });
    const bounds = monthBoundsUtc(parsedMonth.data);
    where.date = { gte: bounds.start, lt: bounds.end };
  }
  if (type === "meno" || type === "tulo") where.type = type;
  if (category) where.category = category;
  if (source === "ai" || source === "ocr" || source === "manual") where.source = source;

  const linkedStatus = url.searchParams.get("linkedStatus");
  if (linkedStatus === "linked") where.linkedTransaction = { isNot: null };
  if (linkedStatus === "unlinked") where.linkedTransaction = null;

  const amountFilter: { gte?: number; lte?: number } = {};
  try {
    if (minAmount != null && minAmount !== "") amountFilter.gte = eurosToCents(Number(minAmount));
    if (maxAmount != null && maxAmount !== "") amountFilter.lte = eurosToCents(Number(maxAmount));
  } catch {
    return noStoreJson({ error: "Virheellinen summa" }, { status: 400 });
  }
  if (amountFilter.gte !== undefined && amountFilter.lte !== undefined && amountFilter.gte > amountFilter.lte) {
    return noStoreJson({ error: "Summarajaus on virheellinen" }, { status: 400 });
  }
  if (Object.keys(amountFilter).length > 0) where.totalAmountCents = amountFilter;
  if (q) {
    where.OR = [
      { vendor: { contains: q } },
      { fileName: { contains: q } },
      { category: { contains: q } },
    ];
  }

  let orderBy: Prisma.ReceiptOrderByWithRelationInput = { date: "desc" };
  if (sort === "date_asc") orderBy = { date: "asc" };
  else if (sort === "amount_desc") orderBy = { totalAmountCents: "desc" };
  else if (sort === "amount_asc") orderBy = { totalAmountCents: "asc" };
  else if (sort === "created_desc") orderBy = { createdAt: "desc" };

  const [receipts, count] = await Promise.all([
    prisma.receipt.findMany({
      where,
      orderBy,
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
  ]);

  const matchViews = await buildReceiptMatchViews(
    session.userId!,
    receipts.map(({ totalAmountCents, linkedTransaction, ...receipt }) => ({
      ...receipt,
      totalAmount: totalAmountCents == null ? null : centsToEuros(totalAmountCents),
      linkedTransaction,
    }))
  );

  return noStoreJson({
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
          matchCandidates: (match?.matchCandidates ?? []).map((c) => ({
            ...c,
            date: c.date?.toISOString() ?? null,
          })),
        },
      };
    }),
    count,
    truncated: count > receipts.length,
  });
}
