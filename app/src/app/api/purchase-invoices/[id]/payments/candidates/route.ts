import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { listBankRowsForPurchase } from "@/lib/purchase-bank-match";
import { monthSchema } from "@/lib/validation";

const querySchema = z.object({
  q: z.string().trim().max(100).optional(),
  month: monthSchema.optional(),
});

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Outgoing bank rows that may have paid this purchase invoice, best first,
 * each with its Finnish reasons ("summa sama", "nimi vastaa", "summa poikkeaa
 * 2,00 €"). Linking is POST ../payments with the row's `transactionId`.
 */
export const GET = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  const { id } = await context.params;
  const params = req.nextUrl.searchParams;
  const query = querySchema.parse({
    q: params.get("q") || undefined,
    month: params.get("month") || undefined,
  });
  return noStoreJson(await listBankRowsForPurchase(session.userId, id, query));
});
