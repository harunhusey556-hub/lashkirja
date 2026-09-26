import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { UnauthorizedError, ValidationError, withErrorHandler } from "@/lib/api-errors";
import { recordPurchasePayment, removePurchasePayment } from "@/lib/purchase-invoices";
import { isoDateSchema, moneySchema } from "@/lib/validation";

const bodySchema = z.object({
  amount: moneySchema,
  paidDate: isoDateSchema,
  transactionId: z.string().uuid().nullish(),
  note: z.string().trim().max(200).nullish(),
});

type RouteContext = { params: Promise<{ id: string }> };

export const POST = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req);
  if (oversized) return oversized;

  const { id } = await context.params;
  const invoice = await recordPurchasePayment(
    session.userId,
    id,
    bodySchema.parse(await req.json())
  );
  return noStoreJson({ invoice }, { status: 201 });
});

export const DELETE = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;

  const { id } = await context.params;
  const paymentId = req.nextUrl.searchParams.get("paymentId");
  if (!paymentId) throw new ValidationError("Maksun tunnus puuttuu.");

  return noStoreJson({ invoice: await removePurchasePayment(session.userId, id, paymentId) });
});
