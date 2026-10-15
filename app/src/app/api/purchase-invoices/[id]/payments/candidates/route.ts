import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { listBankRowsForPurchase, PURCHASE_CANDIDATE_MAX_LIMIT } from "@/lib/purchase-bank-match";
import { monthSchema } from "@/lib/validation";

const querySchema = z.object({
  q: z.string().trim().max(100).optional(),
  month: monthSchema.optional(),
  offset: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(PURCHASE_CANDIDATE_MAX_LIMIT).optional(),
});

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Outgoing bank rows that may have paid this purchase invoice, best first,
 * each with its Finnish reasons ("summa sama", "nimi vastaa", "summa poikkeaa
 * 2,00 €"), a page at a time (`offset`, `limit`). Linking is POST ../payments
 * with the row's `transactionId`.
 */
export const GET = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  const { id } = await context.params;
  const params = req.nextUrl.searchParams;
  const query = querySchema.parse({
    q: params.get("q") || undefined,
    month: params.get("month") || undefined,
    offset: params.get("offset") || undefined,
    limit: params.get("limit") || undefined,
  });
  return noStoreJson(await listBankRowsForPurchase(session.userId, id, query));
});
