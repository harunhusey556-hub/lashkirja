import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import {
  deleteRecurringInvoice,
  getRecurringInvoice,
  updateRecurringInvoice,
} from "@/lib/recurring-invoices";
import { isoDateSchema, moneySchema } from "@/lib/validation";

const lineSchema = z.object({
  description: z.string().trim().min(1).max(200),
  quantity: z.number().finite(),
  unit: z.string().trim().max(16).optional(),
  unitPrice: moneySchema,
  vatRate: z.number().finite().min(0).max(100),
});

const patchSchema = z
  .object({
    customerId: z.string().uuid().optional(),
    name: z.string().trim().max(120).nullish(),
    interval: z.enum(["monthly", "quarterly", "yearly"]).optional(),
    anchorDay: z.number().int().min(1).max(31).optional(),
    startDate: isoDateSchema.optional(),
    endDate: isoDateSchema.nullish(),
    paymentTermDays: z.number().int().min(0).max(365).optional(),
    notes: z.string().trim().max(2000).nullish(),
    autoSend: z.boolean().optional(),
    active: z.boolean().optional(),
    lines: z.array(lineSchema).min(1).max(200).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Ei muutettavia kenttiä");

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  const { id } = await context.params;
  return noStoreJson({ recurring: await getRecurringInvoice(session.userId, id) });
});

export const PATCH = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req);
  if (oversized) return oversized;

  const { id } = await context.params;
  const recurring = await updateRecurringInvoice(
    session.userId,
    id,
    patchSchema.parse(await req.json())
  );
  return noStoreJson({ recurring });
});

export const DELETE = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;

  const { id } = await context.params;
  await deleteRecurringInvoice(session.userId, id);
  return noStoreJson({ ok: true });
});
