import { NextRequest } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { noStoreJson } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { buildReceiptWhere, ReceiptFilterError, receiptKindWhere, receiptLinkWhere, withReceiptSearch } from "@/lib/receipt-filters";

/**
 * Per-tab receipt counts for the kuitit list's filter chips (Kaikki /
 * Myynnit / Ostot / Linkitetty / Ei linkitetty). Separate from
 * `GET /api/receipts`, whose row list is capped at `MAX_LIST_ROWS` - a count
 * over that capped list would silently undercount past the cap, so this
 * counts the database directly, scoped by the same month/search/advanced
 * filters the visible list uses (everything except the tab dimension
 * itself, which each count below overlays on top of the shared base clause).
 */
export const GET = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const params = req.nextUrl.searchParams;
  let base: Prisma.ReceiptWhereInput;
  try {
    base = buildReceiptWhere(session.userId!, {
      reviewStatus: params.get("reviewStatus"),
      month: params.get("month"),
      q: params.get("q"),
      category: params.get("category"),
      source: params.get("source"),
      minAmount: params.get("minAmount"),
      maxAmount: params.get("maxAmount"),
      vat: params.get("vat"),
    });
    base = await withReceiptSearch(base, params.get("q"));
  } catch (error) {
    if (error instanceof ReceiptFilterError) return noStoreJson({ error: error.message }, { status: 400 });
    throw error;
  }

  // Kaikki / Tulot / Menot count the list's own kind (`kind=receipt` from Kuitit);
  // Kohdistettu / Ei kohdistettu count every document a bank row does or does not
  // explain, bills included, exactly as the list filters them (receiptLinkWhere);
  // "laskut" always counts the bills filed as ostolaskut, the Laskut chip's rows.
  const shared = base;
  const kind = params.get("kind");
  base = { ...shared, ...receiptKindWhere(kind) };
  const [all, tulo, meno, linked, unlinked, laskut] = await Promise.all([
    prisma.receipt.count({ where: base }),
    prisma.receipt.count({ where: { ...base, type: "tulo" } }),
    prisma.receipt.count({ where: { ...base, type: "meno" } }),
    prisma.receipt.count({ where: { AND: [shared, receiptLinkWhere("linked", kind)!] } }),
    prisma.receipt.count({ where: { AND: [shared, receiptLinkWhere("unlinked", kind)!] } }),
    prisma.receipt.count({ where: { ...shared, ...receiptKindWhere("invoice") } }),
  ]);

  return noStoreJson({ counts: { all, tulo, meno, linked, unlinked, laskut } });
});
