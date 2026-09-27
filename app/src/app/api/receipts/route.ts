import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import type { ExtractedReceipt } from "@/lib/ai";
import { enqueueDocumentAnalysis } from "@/lib/document-jobs";
import { centsToEuros, eurosToCents } from "@/lib/money";
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
import { monthBoundsUtc, monthSchema } from "@/lib/validation";
import { buildReceiptMatchViews } from "@/lib/matching";
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

async function discardStagedUpload(userId: string, upload: { id: string; storageKey: string }) {
  await removeUserUpload(userId, upload.storageKey).catch(() => {});
  await prisma.upload.deleteMany({ where: { id: upload.id, userId, claimedAt: null } });
}

function wantsAiUpgrade(upload: StagedUploadRow): boolean {
  return Boolean(
    upload.extractedJson &&
      upload.extractionSource !== "ai" &&
      (process.env.LLM_API_KEY || process.env.COPILOT_GITHUB_TOKEN)
  );
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
      const receipt = await prisma.receipt.findFirst({
        where: { userId: session.userId!, uploadId: existing.id },
        select: { id: true },
      });
      return noStoreJson(
        {
          error: "Tämä kuitti on jo tallennettu",
          code: "DUPLICATE_DOCUMENT",
          receiptId: receipt?.id ?? null,
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
