import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { rejectPurchaseSuggestion } from "@/lib/purchase-bank-match";

const bodySchema = z.object({
  invoiceId: z.string().uuid(),
  transactionId: z.string().uuid(),
});

/** "Hylkää" on a purchase payment suggestion: the pair is not suggested again. */
export const POST = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req);
  if (oversized) return oversized;

  const input = bodySchema.parse(await req.json());
  await rejectPurchaseSuggestion(session.userId, input.invoiceId, input.transactionId);
  return noStoreJson({ ok: true });
});
