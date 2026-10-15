import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { listPurchasesForBankRow, PURCHASE_CANDIDATE_MAX_LIMIT } from "@/lib/purchase-bank-match";

const querySchema = z.object({
  transactionId: z.string().uuid(),
  q: z.string().trim().max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(PURCHASE_CANDIDATE_MAX_LIMIT).optional(),
});

/**
 * Open purchase invoices that one outgoing bank row may have paid, best first
 * (the bank row sheet's "Kohdista ostolaskuun"), a page at a time. Linking is
 * POST /api/purchase-invoices/[id]/payments with this `transactionId`.
 */
export const GET = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  const params = req.nextUrl.searchParams;
  const query = querySchema.parse({
    transactionId: params.get("transactionId") ?? undefined,
    q: params.get("q") || undefined,
    offset: params.get("offset") || undefined,
    limit: params.get("limit") || undefined,
  });
  return noStoreJson(await listPurchasesForBankRow(session.userId, query.transactionId, query));
});
