import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { getCustomer, removeCustomer, updateCustomer } from "@/lib/customers";

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    businessId: z.string().trim().max(20).nullish(),
    contactPerson: z.string().trim().max(120).nullish(),
    email: z.string().trim().max(160).nullish(),
    phone: z.string().trim().max(40).nullish(),
    addressStreet: z.string().trim().max(120).nullish(),
    addressPostalCode: z.string().trim().max(20).nullish(),
    addressCity: z.string().trim().max(80).nullish(),
    country: z.string().trim().length(2).optional(),
    defaultPaymentTermDays: z.number().int().min(0).max(365).optional(),
    notes: z.string().trim().max(2000).nullish(),
    archived: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Ei muutettavia kenttiä");

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  const { id } = await context.params;
  return noStoreJson({ customer: await getCustomer(session.userId, id) });
});

export const PATCH = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req);
  if (oversized) return oversized;

  const { id } = await context.params;
  const customer = await updateCustomer(session.userId, id, patchSchema.parse(await req.json()));
  return noStoreJson({ customer });
});

export const DELETE = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;

  const { id } = await context.params;
  return noStoreJson({ ok: true, ...(await removeCustomer(session.userId, id)) });
});
