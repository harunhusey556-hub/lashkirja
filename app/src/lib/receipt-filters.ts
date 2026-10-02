import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { eurosToCents } from "@/lib/money";
import { matchesSearch } from "@/lib/search";
import { periodScopeBoundsUtc, periodScopeSchema } from "@/lib/validation";

export interface ReceiptWhereInput {
  reviewStatus?: string | null;
  month?: string | null;
  q?: string | null;
  category?: string | null;
  source?: string | null;
  minAmount?: string | null;
  maxAmount?: string | null;
  /** "missing": only receipts with no VAT breakdown (Raportit's "Ilman ALV-erittelyä"). */
  vat?: string | null;
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
    // A month, or a whole year when a yearly report figure opened the list.
    const parsedMonth = periodScopeSchema.safeParse(input.month);
    if (!parsedMonth.success) throw new ReceiptFilterError("Virheellinen kuukausi");
    const bounds = periodScopeBoundsUtc(parsedMonth.data);
    where.date = { gte: bounds.start, lt: bounds.end };
  }
  if (input.category) where.category = input.category.slice(0, 100);
  if (input.source === "ai" || input.source === "ocr" || input.source === "manual" || input.source === "email_sync") {
    where.source = input.source;
  }

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
  // The same rule as the report's missingVatCount (parseVatDetails): no lines stored at all.
  if (input.vat === "missing") {
    where.AND = [{ OR: [{ vatDetails: null }, { vatDetails: "" }, { vatDetails: "[]" }] }];
  }

  return where;
}

/**
 * Narrows a receipt `where` to the rows a search text finds in vendor, file
 * name or category. Done in memory: SQLite LIKE folds ASCII case only and
 * reads % and _ as wildcards (`äiti` must find `Äiti`).
 */
export async function withReceiptSearch(
  where: Prisma.ReceiptWhereInput,
  q: string | null | undefined
): Promise<Prisma.ReceiptWhereInput> {
  const text = (q || "").trim().slice(0, 100);
  if (!text) return where;
  const candidates = await prisma.receipt.findMany({
    where,
    select: { id: true, vendor: true, fileName: true, category: true },
  });
  const ids = candidates
    .filter((row) => matchesSearch(text, [row.vendor, row.fileName, row.category]))
    .map((row) => row.id);
  return { ...where, id: { in: ids } };
}
