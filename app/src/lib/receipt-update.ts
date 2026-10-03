/**
 * The receipt edit (PATCH /api/receipts/[id]) as a function, so the
 * assistant's accepted "receipt_update" proposal writes through exactly the
 * same rules: VAT lines must fit the total, both the old and the new date
 * must be in an open period, an edit made meanwhile is a conflict, and a
 * category change is remembered as the owner's correction.
 */
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "./db";
import { centsToEuros, eurosToCents } from "./money";
import { isoDateToUtc } from "./validation";
import { NotFoundError, ValidationError } from "./api-errors";
import { sanitizeText } from "./sanitizer";
import { assertPeriodOpen } from "./period-lock";
import { parseVatDetails } from "./alv";
import { sameVatLines, vatLinesProblem } from "./receipt-vat";
import { versionConflict } from "./edit-conflict";

export interface ReceiptPatch {
  vendor?: string | null;
  date?: string | null;
  totalAmount?: number | null;
  vatDetails?: Array<{ rate: number; amount: number }> | null;
  category?: string | null;
  notes?: string | null;
  type?: "meno" | "tulo";
  reference?: string | null;
  invoiceNumber?: string | null;
}

export const UPDATED_RECEIPT_SELECT = {
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
} as const;

type Db = Prisma.TransactionClient;

async function applyIn(tx: Db, userId: string, id: string, body: ReceiptPatch, expected: Date | null) {
  const owned = await tx.receipt.findFirst({ where: { id, userId } });
  if (!owned) throw new NotFoundError("Kuittia ei löytynyt");

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
  await assertPeriodOpen(userId, [owned.date, body.date ? isoDateToUtc(body.date) : null], tx);

  const won = await tx.receipt.updateMany({
    where: { id, userId, ...(expected ? { updatedAt: expected } : {}) },
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
    const still = await tx.receipt.findFirst({ where: { id, userId }, select: { id: true } });
    if (!still) throw new NotFoundError("Kuittia ei löytynyt");
    throw versionConflict();
  }
  if (body.category !== undefined) {
    const nextCategory = sanitizeText(body.category);
    if (nextCategory !== owned.category) {
      await tx.automationEvent.create({
        data: {
          userId,
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
  const receipt = await tx.receipt.findFirst({ where: { id }, select: UPDATED_RECEIPT_SELECT });
  if (!receipt) throw new NotFoundError("Kuittia ei löytynyt");
  return receipt;
}

/**
 * Applies `body` to the owner's receipt. `expected` (the updatedAt the edit
 * was based on) turns a change made meanwhile into a 409. With `db` the
 * write joins the caller's transaction; matching is the caller's to run.
 */
export async function applyReceiptPatch(
  userId: string,
  id: string,
  body: ReceiptPatch,
  options: { expected?: Date | null; db?: Db } = {}
) {
  const expected = options.expected ?? null;
  if (options.db) return applyIn(options.db, userId, id, body, expected);
  return prisma.$transaction((tx) => applyIn(tx, userId, id, body, expected));
}
