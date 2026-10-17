import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { buildReceiptMatchViews } from "@/lib/matching";
import { centsToEuros, eurosToCents } from "@/lib/money";
import { isoDateSchema, isoDateToUtc, moneySchema } from "@/lib/validation";
import { creditSigned, creditSignedVatLines } from "@/lib/ai";
import {
  noStoreJson,
  rejectCrossSite,
  rejectOversizedContentLength,
} from "@/lib/http-security";
import { withErrorHandler, UnauthorizedError, AppError, ValidationError } from "@/lib/api-errors";
import { sanitizeText } from "@/lib/sanitizer";
import { assertPeriodOpen } from "@/lib/period-lock";
import { negativeAmountProblem, vatLinesProblem } from "@/lib/receipt-vat";
import { PURCHASE_VAT_TREATMENTS } from "@/lib/alv";
import { currencySchema, foreignColumns } from "@/lib/foreign-purchase-input";
import {
  findLookAlikeReceipt,
  withDuplicateNote,
  matchAfterReceiptSave,
  settleAutoAccept,
  storedDocumentKind,
} from "@/lib/receipt-staging";
import { fileReceiptAsPurchaseInvoice } from "@/lib/purchase-invoices";
import { euroConversionForSave, withFxRecorded } from "@/lib/fx-rates";

// Signed: a credit note may arrive with its printed minus. Only a credit note
// may be negative (checked against the stored reading below).
const vatLineSchema = z.object({
  rate: z.number().finite().min(0).max(100),
  amount: moneySchema,
});

const saveSchema = z.object({
  uploadId: z.string().uuid(),
  vendor: z.string().trim().max(300).nullish(),
  date: isoDateSchema.nullish(),
  totalAmount: moneySchema.nullish(),
  vatDetails: z.array(vatLineSchema).max(20).nullish(),
  category: z.string().trim().max(100).nullish(),
  notes: z.string().trim().max(500).nullish(),
  type: z.enum(["meno", "tulo"]).default("meno"),
  reference: z.string().trim().max(40).nullish(),
  invoiceNumber: z.string().trim().max(40).nullish(),
  currency: currencySchema.optional(),
  originalAmount: moneySchema.nullish(),
  vatTreatment: z.enum(PURCHASE_VAT_TREATMENTS).optional(),
  forceDuplicate: z.boolean().default(false),
  // W8: the upload queue asks the server to approve a complete reading in the
  // same transaction (lib/auto-accept.ts); anything the rule refuses is pending.
  autoApprove: z.boolean().default(false),
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

  // The stored reading says whether this is a credit note. The form shows its
  // amounts as positive sizes; it is booked negative whichever way they arrive.
  const staged = await prisma.upload.findFirst({
    where: { id: parsed.uploadId, userId: session.userId!, purpose: "receipt" },
    select: { extractedJson: true },
  });
  const creditNote = storedDocumentKind(staged?.extractedJson ?? null).isCreditNote;
  const signProblem = negativeAmountProblem(parsed, creditNote);
  if (signProblem) throw new ValidationError(signProblem);
  const body = creditNote ? amountSizes(parsed) : parsed;

  // The form refuses a VAT larger than the total or an unknown rate; an API client is held to the same rule.
  const vatProblem = vatLinesProblem(body.vatDetails ?? [], body.totalAmount);
  if (vatProblem) throw new ValidationError(vatProblem);

  // A receipt dated inside a closed period would change a filed VAT return.
  await assertPeriodOpen(session.userId, [body.date ? isoDateToUtc(body.date) : null]);

  if (!body.forceDuplicate && body.vendor && body.date && body.totalAmount != null) {
    const existingDuplicate = await findLookAlikeReceipt(prisma, session.userId!, {
      vendor: sanitizeText(body.vendor),
      date: isoDateToUtc(body.date),
      totalAmountCents: creditSigned(eurosToCents(body.totalAmount), creditNote),
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

  // A foreign document saved without a euro figure is priced at the rate the document
  // printed or the ECB's. Looked up before the transaction: no network inside a write lock.
  let fx: Awaited<ReturnType<typeof euroConversionForSave>> = null;
  if (body.totalAmount == null) {
    fx = await euroConversionForSave(body, staged?.extractedJson ?? null);
  }

  try {
    // The stored reading names the document kind (kuitti / lasku / ...): a bill
    // is filed as an ostolasku below, so it is never silently a plain receipt.
    let reading = storedDocumentKind(null);
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
      reading = storedDocumentKind(upload.extractedJson);

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
      const recorded = fx ? withFxRecorded(upload.extractedJson, fx) : null;
      if (recorded) await db.upload.update({ where: { id: upload.id }, data: { extractedJson: recorded } });

      const foreign = foreignColumns(body, upload.extractedJson);
      const created = await db.receipt.create({
        data: {
          userId: session.userId!,
          uploadId: upload.id,
          vendor: sanitizeText(body.vendor),
          date: body.date ? isoDateToUtc(body.date) : null,
          totalAmountCents: fx
            ? creditSigned(eurosToCents(fx.totalAmount), creditNote)
            : body.totalAmount == null
              ? null
              : creditSigned(eurosToCents(body.totalAmount), creditNote),
          vatDetails: body.vatDetails?.length ? JSON.stringify(creditSignedVatLines(body.vatDetails, creditNote)) : null,
          category: sanitizeText(body.category),
          // A look-alike the client chose to keep says so, or two identical rows wait side by side.
          notes: body.forceDuplicate ? withDuplicateNote(sanitizeText(body.notes)) : sanitizeText(body.notes),
          type: body.type,
          reference: sanitizeText(body.reference),
          invoiceNumber: sanitizeText(body.invoiceNumber),
          filePath: upload.storageKey,
          fileName: upload.originalName,
          source: upload.extractionSource || "manual",
          // Typed in by hand (nothing could be read): no recognition score, so the editor
          // never marks the user's own fields as uncertain (V11).
          confidence: upload.extractionSource === "manual" ? null : upload.confidence,
          rawText: upload.rawText,
          ...foreign,
          originalAmountCents:
            foreign.originalAmountCents == null ? null : creditSigned(foreign.originalAmountCents, creditNote),
        },
      });
      if (!body.autoApprove) return created;
      // W8 auto-accept: judged on the row as stored, inside the create's own
      // transaction, so a crash can never leave it half approved. The guards are
      // the manual approve's (amount, open period - asserted above); a new
      // receipt has no source bank row, so nothing else of that path applies.
      return settleAutoAccept(db, created, {
        documentType: reading.documentType,
        // forceDuplicate = the client was told about a look-alike and insisted.
        duplicate: body.forceDuplicate,
        isCreditNote: reading.isCreditNote,
      });
    });

    // The AI read a payable bill: file it as the ostolasku of the same
    // purchase, linked to this receipt so the VAT return never counts it twice.
    const filing = await fileReceiptAsPurchaseInvoice(session.userId!, receipt, reading);

    // A bill uploaded after the bank already showed its payment (the owner's 24 of
    // 2026-10-12): the row carrying its viite pays the new ostolasku now.
    await matchAfterReceiptSave(session.userId!, filing.created);

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

    const { totalAmountCents: _tac, originalAmountCents, rawText: _rawText, filePath: _filePath, userId: _userId, ...safe } = receipt;
    return noStoreJson({
      ok: true,
      receipt: {
        ...safe,
        totalAmount,
        originalAmount: originalAmountCents == null ? null : centsToEuros(originalAmountCents),
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
      // What the reading turned into, so a bill is never filed as a plain
      // kuitti behind the owner's back: the ostolasku created for it, or why
      // none was (an ordinary receipt, an unclear reading, a duplicate...).
      purchaseInvoice: filing.created ? filing.invoice : null,
      purchaseInvoiceSkipped: filing.created ? null : filing.skipped,
      // The rate that priced a foreign total the owner left empty; null otherwise.
      fx,
      ...(body.autoApprove ? { autoApproved: receipt.reviewStatus === "approved" } : {}),
    });
  } catch (error) {
    if (error instanceof UploadClaimError) {
      throw new AppError("Latausta ei löytynyt tai se on jo käytetty", "CONFLICT", 409);
    }
    throw error; // Let generic errors bubble up to handler
  }
});

class UploadClaimError extends Error {}

/** A credit note's amounts as sizes, however they were sent; the sign is put back when the row is written. */
function amountSizes<T extends z.infer<typeof saveSchema>>(body: T): T {
  return {
    ...body,
    totalAmount: body.totalAmount == null ? body.totalAmount : Math.abs(body.totalAmount),
    originalAmount: body.originalAmount == null ? body.originalAmount : Math.abs(body.originalAmount),
    vatDetails: body.vatDetails?.map((line) => ({ ...line, amount: Math.abs(line.amount) })) ?? body.vatDetails,
  };
}
