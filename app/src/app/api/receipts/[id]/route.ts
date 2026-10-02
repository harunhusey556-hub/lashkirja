import { NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { runMatching, buildReceiptMatchViews } from "@/lib/matching";
import { dismissIncomeDraft } from "@/lib/income-automation";
import { centsToEuros, eurosToCents } from "@/lib/money";
import { removeUserUpload } from "@/lib/storage";
import { isoDateSchema, isoDateToUtc, nonnegativeMoneySchema } from "@/lib/validation";
import {
  noStoreJson,
  rejectCrossSite,
  rejectOversizedContentLength,
} from "@/lib/http-security";
import { withErrorHandler, UnauthorizedError, NotFoundError, ValidationError } from "@/lib/api-errors";
import { sanitizeText } from "@/lib/sanitizer";

import { assertPeriodOpen } from "@/lib/period-lock";
import { parseVatDetails } from "@/lib/alv";
import { sameVatLines, vatLinesProblem } from "@/lib/receipt-vat";
import { expectedUpdatedAtDate, versionConflict } from "@/lib/edit-conflict";
const patchSchema = z.object({
  vendor: z.string().trim().max(300).nullish(),
  date: isoDateSchema.nullish(),
  totalAmount: nonnegativeMoneySchema.nullish(),
  vatDetails: z.array(z.object({
    rate: z.number().finite().min(0).max(100),
    amount: nonnegativeMoneySchema,
  })).max(20).nullish(),
  category: z.string().trim().max(100).nullish(),
  notes: z.string().trim().max(500).nullish(),
  type: z.enum(["meno", "tulo"]).optional(),
  reference: z.string().trim().max(40).nullish(),
  invoiceNumber: z.string().trim().max(40).nullish(),
  expectedUpdatedAt: z.string().max(40).optional(),
}).strict();

async function findOwnedReceipt(id: string, userId: string) {
  return prisma.receipt.findFirst({ where: { id, userId } });
}

export const GET = withErrorHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError("Ei kirjautunut");
  const { id } = await params;
  const receipt = await prisma.receipt.findFirst({
    where: { id, userId: session.userId! },
    select: {
      id: true,
      vendor: true,
      date: true,
      totalAmountCents: true,
      // The native app shows Hyväksy / Hylkää from it.
      reviewStatus: true,
      vatDetails: true,
      category: true,
      notes: true,
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
  });
  if (!receipt) return noStoreJson({ error: "Kuittia ei löytynyt" }, { status: 404 });

  const { totalAmountCents, linkedTransaction, ...safe } = receipt;
  const totalAmount = totalAmountCents == null ? null : centsToEuros(totalAmountCents);
  const matchViews = await buildReceiptMatchViews(session.userId!, [
    {
      id: receipt.id,
      vendor: receipt.vendor,
      date: receipt.date,
      totalAmount,
      type: receipt.type,
      reference: receipt.reference,
      invoiceNumber: receipt.invoiceNumber,
      linkedTransaction,
    },
  ]);
  const match = matchViews.get(receipt.id);

  return noStoreJson({
    receipt: {
      ...safe,
      totalAmount,
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
    },
  });
});

export const PATCH = withErrorHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError("Ei kirjautunut");
  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req);
  if (oversized) return oversized;

  const { id } = await params;
  const owned = await findOwnedReceipt(id, session.userId!);
  if (!owned) {
    return noStoreJson({ error: "Kuittia ei löytynyt" }, { status: 404 });
  }
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  // The shared 400 answer names the field and the limit in Finnish (F64).
  if (!parsed.success) throw parsed.error;
  if (Object.keys(parsed.data).length === 0) {
    return noStoreJson({ error: "Ei päivitettäviä kenttiä" }, { status: 400 });
  }
  const { expectedUpdatedAt, ...body } = parsed.data;
  if (Object.keys(body).length === 0) {
    return noStoreJson({ error: "Ei päivitettäviä kenttiä" }, { status: 400 });
  }
  const expected = expectedUpdatedAtDate(expectedUpdatedAt);

  // The VAT that would be stored (the sent one, or the stored one when only the
  // total changes) must fit the total that would be stored: same rule as save.
  if (body.vatDetails !== undefined || body.totalAmount !== undefined) {
    const storedLines = (parseVatDetails(owned.vatDetails) ?? []).map((line) => ({
      rate: line.rate,
      amount: centsToEuros(line.amountCents),
    }));
    const vatLines = body.vatDetails !== undefined ? (body.vatDetails ?? []) : storedLines;
    const totalAmount =
      body.totalAmount !== undefined
        ? body.totalAmount
        : owned.totalAmountCents == null
          ? null
          : centsToEuros(owned.totalAmountCents);
    // Lines sent back exactly as stored are not a change: an old off-list rate must not
    // block an edit of something else (R61). Any changed line is held to the save rule.
    const vatChanged = body.vatDetails !== undefined && !sameVatLines(vatLines, storedLines);
    const vatProblem = vatLinesProblem(vatLines, totalAmount, vatChanged);
    if (vatProblem) throw new ValidationError(vatProblem);
  }

  // Both where the receipt is now and where it would move to must be open.
  await assertPeriodOpen(session.userId!, [
    owned.date,
    body.date ? isoDateToUtc(body.date) : null,
  ]);

  const receipt = await prisma.$transaction(async (tx) => {
    const won = await tx.receipt.updateMany({
      where: {
        id,
        userId: session.userId!,
        ...(expected ? { updatedAt: expected } : {}),
      },
      data: {
      ...(body.vendor !== undefined ? { vendor: sanitizeText(body.vendor) } : {}),
      ...(body.date !== undefined ? { date: body.date ? isoDateToUtc(body.date) : null } : {}),
      ...(body.totalAmount !== undefined
        ? { totalAmountCents: body.totalAmount == null ? null : eurosToCents(body.totalAmount) }
        : {}),
      ...(body.vatDetails !== undefined
        ? { vatDetails: body.vatDetails?.length ? JSON.stringify(body.vatDetails) : null }
        : {}),
      ...(body.category !== undefined ? { category: sanitizeText(body.category) } : {}),
      ...(body.notes !== undefined ? { notes: sanitizeText(body.notes) } : {}),
      ...(body.type !== undefined ? { type: body.type } : {}),
      ...(body.reference !== undefined ? { reference: sanitizeText(body.reference) } : {}),
      ...(body.invoiceNumber !== undefined ? { invoiceNumber: sanitizeText(body.invoiceNumber) } : {}),
      },
    });
    if (won.count === 0) {
      const still = await tx.receipt.findFirst({
        where: { id, userId: session.userId! },
        select: { id: true },
      });
      if (!still) throw new NotFoundError("Kuittia ei löytynyt");
      throw versionConflict();
    }
    if (body.category !== undefined) {
      const nextCategory = sanitizeText(body.category);
      if (nextCategory !== owned.category) {
        await tx.automationEvent.create({
          data: {
            userId: session.userId!,
            kind: "category",
            resourceType: "receipt",
            resourceId: id,
            previousValue: owned.category,
            newValue: nextCategory,
            reason: "käyttäjän korjaus",
          },
        });
      }
    }
    return tx.receipt.findFirst({
      where: { id },
      select: {
        id: true,
        vendor: true,
        date: true,
        totalAmountCents: true,
        vatDetails: true,
        category: true,
        notes: true,
        type: true,
        reference: true,
        invoiceNumber: true,
        fileName: true,
        source: true,
        confidence: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  });
  if (!receipt) throw new NotFoundError("Kuittia ei löytynyt");

  await runMatching(session.userId!).catch((error) =>
    console.error("Matching after receipt edit failed:", error)
  );
  const { totalAmountCents, ...safe } = receipt;
  return noStoreJson({
    ok: true,
    receipt: { ...safe, totalAmount: totalAmountCents == null ? null : centsToEuros(totalAmountCents) },
  });
});

export const DELETE = withErrorHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError("Ei kirjautunut");
  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;

  const { id } = await params;
  const existing = await findOwnedReceipt(id, session.userId!);
  if (!existing) return noStoreJson({ error: "Kuittia ei löytynyt" }, { status: 404 });
  // Deleting a receipt changes a filed return exactly as much as editing one.
  await assertPeriodOpen(session.userId!, [existing.date]);

  await prisma.$transaction(async (db) => {
    await db.transaction.updateMany({
      where: {
        statement: { userId: session.userId! },
        OR: [{ receiptId: id }, { suggestedReceiptId: id }],
      },
      data: {
        receiptId: null,
        suggestedReceiptId: null,
        matchStatus: "unmatched",
        matchScore: null,
        matchReasons: null,
      },
    });
    await dismissIncomeDraft(db, session.userId!, existing);
    await db.receipt.delete({ where: { id } });
    if (existing.uploadId) await db.upload.deleteMany({ where: { id: existing.uploadId, userId: session.userId! } });
  });

  await removeUserUpload(session.userId!, existing.filePath, true).catch((error) =>
    console.error("Receipt file cleanup failed:", error)
  );
  return noStoreJson({ ok: true });
});
