import { NextRequest } from "next/server";
import { z } from "zod";
import { PURCHASE_VAT_TREATMENTS } from "@/lib/alv";
import { currencySchema } from "@/lib/foreign-purchase-input";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import {
  deletePurchaseInvoice,
  getPurchaseInvoice,
  updatePurchaseInvoice,
} from "@/lib/purchase-invoices";
import { isoDateSchema, moneySchema, nonnegativeMoneySchema } from "@/lib/validation";

const patchSchema = z
  .object({
    supplierName: z.string().trim().min(1).max(120).optional(),
    supplierBusinessId: z.string().trim().max(20).nullish(),
    supplierIban: z.string().trim().max(42).nullish(),
    invoiceNumber: z.string().trim().max(40).nullish(),
    reference: z.string().trim().max(30).nullish(),
    issueDate: isoDateSchema.optional(),
    dueDate: isoDateSchema.optional(),
    gross: moneySchema.optional(),
    vat: nonnegativeMoneySchema.optional(),
    category: z.string().trim().max(60).nullish(),
    notes: z.string().trim().max(2000).nullish(),
    receiptId: z.string().uuid().nullish(),
    currency: currencySchema.optional(),
    originalAmount: nonnegativeMoneySchema.nullish(),
    vatTreatment: z.enum(PURCHASE_VAT_TREATMENTS).optional(),
    status: z.enum(["open", "paid", "cancelled"]).optional(),
    closeReason: z.string().trim().min(3).max(500).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Ei muutettavia kenttiä");

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  const { id } = await context.params;
  return noStoreJson({ invoice: await getPurchaseInvoice(session.userId, id) });
});

export const PATCH = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req);
  if (oversized) return oversized;

  const { id } = await context.params;
  const invoice = await updatePurchaseInvoice(
    session.userId,
    id,
    patchSchema.parse(await req.json())
  );
  return noStoreJson({ invoice });
});

export const DELETE = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;

  const { id } = await context.params;
  await deletePurchaseInvoice(session.userId, id);
  return noStoreJson({ ok: true });
});
