import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { runMatching, buildReceiptMatchViews } from "@/lib/matching";
import { centsToEuros, eurosToCents } from "@/lib/money";
import { isoDateSchema, isoDateToUtc, nonnegativeMoneySchema } from "@/lib/validation";
import {
  noStoreJson,
  rejectCrossSite,
  rejectOversizedContentLength,
} from "@/lib/http-security";
import { withErrorHandler, UnauthorizedError, AppError } from "@/lib/api-errors";
import { sanitizeText } from "@/lib/sanitizer";

const vatLineSchema = z.object({
  rate: z.number().finite().min(0).max(100),
  amount: nonnegativeMoneySchema,
});

const saveSchema = z.object({
  uploadId: z.string().uuid(),
  vendor: z.string().trim().max(300).nullish(),
  date: isoDateSchema.nullish(),
  totalAmount: nonnegativeMoneySchema.nullish(),
  vatDetails: z.array(vatLineSchema).max(20).nullish(),
  category: z.string().trim().max(100).nullish(),
  notes: z.string().trim().max(500).nullish(),
  type: z.enum(["meno", "tulo"]).default("meno"),
  reference: z.string().trim().max(40).nullish(),
  invoiceNumber: z.string().trim().max(40).nullish(),
  forceDuplicate: z.boolean().default(false),
}).strict();

export const POST = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError("Ei kirjautunut");
  
  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req);
  if (oversized) return oversized;

  // Let ZodError bubble up to the global error handler
  const parsed = saveSchema.parse(await req.json());
  const body = parsed;

  if (!body.forceDuplicate && body.vendor && body.date && body.totalAmount != null) {
    const totalAmountCents = eurosToCents(body.totalAmount);
    const existingDuplicate = await prisma.receipt.findFirst({
      where: {
        userId: session.userId!,
        vendor: sanitizeText(body.vendor),
        date: isoDateToUtc(body.date),
        totalAmountCents,
        id: { not: undefined } // Just to have something if we wanted to exclude self, but this is create so no self id
      }
    });
    if (existingDuplicate) {
      return NextResponse.json({ 
        error: {
          message: "Sama kuitti näyttää olevan jo tallennettu (sama myyjä, päivämäärä ja summa). Haluatko silti tallentaa sen?",
          details: { isDuplicate: true }
        }
      }, { status: 409 });
    }
  }

  try {
    const receipt = await prisma.$transaction(async (db) => {
      const upload = await db.upload.findFirst({
        where: {
          id: body.uploadId,
          userId: session.userId!,
          purpose: "receipt",
          claimedAt: null,
          expiresAt: { gt: new Date() },
        },
      });
      if (!upload) throw new UploadClaimError();

      const claim = await db.upload.updateMany({
        where: {
          id: upload.id,
          userId: session.userId!,
          claimedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { claimedAt: new Date() },
      });
      if (claim.count !== 1) throw new UploadClaimError();

      return db.receipt.create({
        data: {
          userId: session.userId!,
          uploadId: upload.id,
          vendor: sanitizeText(body.vendor),
          date: body.date ? isoDateToUtc(body.date) : null,
          totalAmountCents: body.totalAmount == null ? null : eurosToCents(body.totalAmount),
          vatDetails: body.vatDetails?.length ? JSON.stringify(body.vatDetails) : null,
          category: sanitizeText(body.category),
          notes: sanitizeText(body.notes),
          type: body.type,
          reference: sanitizeText(body.reference),
          invoiceNumber: sanitizeText(body.invoiceNumber),
          filePath: upload.storageKey,
          fileName: upload.originalName,
          source: upload.extractionSource || "manual",
          confidence: upload.confidence,
          rawText: upload.rawText,
        },
      });
    });

    await runMatching(session.userId!).catch((error) =>
      console.error("Matching after receipt save failed:", error)
    );

    const freshReceipt = await prisma.receipt.findUnique({
      where: { id: receipt.id },
      include: {
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

    const totalAmount = receipt.totalAmountCents == null ? null : centsToEuros(receipt.totalAmountCents);
    const matchViews = await buildReceiptMatchViews(session.userId!, [
      {
        id: receipt.id,
        vendor: receipt.vendor,
        date: receipt.date,
        totalAmount,
        type: receipt.type,
        reference: receipt.reference,
        invoiceNumber: receipt.invoiceNumber,
        linkedTransaction: freshReceipt?.linkedTransaction ?? null,
      },
    ]);
    const match = matchViews.get(receipt.id);

    const { totalAmountCents: _tac, rawText: _rawText, filePath: _filePath, userId: _userId, ...safe } = receipt;
    return noStoreJson({
      ok: true,
      receipt: {
        ...safe,
        totalAmount,
        linkedTransaction: match?.linkedTransaction
          ? {
              ...match.linkedTransaction,
              date: match.linkedTransaction.date?.toISOString() ?? null,
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
  } catch (error) {
    if (error instanceof UploadClaimError) {
      throw new AppError("Latausta ei löytynyt tai se on jo käytetty", "CONFLICT", 409);
    }
    throw error; // Let generic errors bubble up to handler
  }
});

class UploadClaimError extends Error {}
