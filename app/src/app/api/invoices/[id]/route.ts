import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { deleteInvoice, getInvoice, updateInvoice } from "@/lib/sales-invoices";
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
    issueDate: isoDateSchema.optional(),
    dueDate: isoDateSchema.optional(),
    notes: z.string().trim().max(2000).nullish(),
    lines: z.array(lineSchema).min(1).max(200).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Ei muutettavia kenttiä");

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  const { id } = await context.params;
  return noStoreJson({ invoice: await getInvoice(session.userId, id) });
});

export const PATCH = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req);
  if (oversized) return oversized;

  const { id } = await context.params;
  const invoice = await updateInvoice(session.userId, id, patchSchema.parse(await req.json()));
  return noStoreJson({ invoice });
});

export const DELETE = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;

  const { id } = await context.params;
  await deleteInvoice(session.userId, id);
  return noStoreJson({ ok: true });
});
