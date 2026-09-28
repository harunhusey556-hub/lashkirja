import { Prisma } from "@/generated/prisma/client";
import { eurosToCents } from "@/lib/money";
import { monthBoundsUtc, monthSchema } from "@/lib/validation";

export interface ReceiptWhereInput {
  reviewStatus?: string | null;
  month?: string | null;
  q?: string | null;
  category?: string | null;
  source?: string | null;
  minAmount?: string | null;
  maxAmount?: string | null;
}

export class ReceiptFilterError extends Error {}

/**
 * Builds the `where` clause shared by `GET /api/receipts` (the capped row
 * list) and `GET /api/receipts/counts` (the DB-side chip counts) - every
 * filter except `type`/`linkedStatus`, which is the tab dimension each
 * caller overlays on top of this base clause itself (see the kuitit list's
 * "Kaikki / Myynnit / Ostot / Linkitetty / Ei linkitetty" chips).
 */
export function buildReceiptWhere(userId: string, input: ReceiptWhereInput): Prisma.ReceiptWhereInput {
  const where: Prisma.ReceiptWhereInput = { userId };

  if (input.reviewStatus === "pending") where.reviewStatus = "pending";
  else if (input.reviewStatus === "rejected") where.reviewStatus = "rejected";
  else if (input.reviewStatus === "all") {
    // leave empty to fetch all
  } else where.reviewStatus = "approved"; // Default to approved only

  if (input.month) {
    const parsedMonth = monthSchema.safeParse(input.month);
    if (!parsedMonth.success) throw new ReceiptFilterError("Virheellinen kuukausi");
    const bounds = monthBoundsUtc(parsedMonth.data);
    where.date = { gte: bounds.start, lt: bounds.end };
  }
  if (input.category) where.category = input.category.slice(0, 100);
  if (input.source === "ai" || input.source === "ocr" || input.source === "manual") where.source = input.source;

  const amountFilter: { gte?: number; lte?: number } = {};
  try {
    if (input.minAmount != null && input.minAmount !== "") amountFilter.gte = eurosToCents(Number(input.minAmount));
    if (input.maxAmount != null && input.maxAmount !== "") amountFilter.lte = eurosToCents(Number(input.maxAmount));
  } catch {
    throw new ReceiptFilterError("Virheellinen summa");
  }
  if (amountFilter.gte !== undefined && amountFilter.lte !== undefined && amountFilter.gte > amountFilter.lte) {
    throw new ReceiptFilterError("Summarajaus on virheellinen");
  }
  if (Object.keys(amountFilter).length > 0) where.totalAmountCents = amountFilter;

  const q = (input.q || "").trim().slice(0, 100);
  if (q) {
    where.OR = [
      { vendor: { contains: q } },
      { fileName: { contains: q } },
      { category: { contains: q } },
    ];
  }

  return where;
}
