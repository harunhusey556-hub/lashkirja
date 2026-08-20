import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import {
  getAccountRollforward,
  removeBankAccount,
  updateBankAccount,
} from "@/lib/bank-accounts";
import { isoDateSchema, monthSchema, moneySchema } from "@/lib/validation";

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    bankName: z.string().trim().max(80).nullish(),
    iban: z.string().trim().max(42).nullish(),
    bic: z.string().trim().max(11).nullish(),
    currency: z.string().trim().length(3).optional(),
    openingBalance: moneySchema.optional(),
    openingDate: isoDateSchema.optional(),
    isDefault: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "Ei muutettavia kenttiä");

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const { id } = await context.params;
  const throughRaw = req.nextUrl.searchParams.get("through");
  const through = throughRaw ? monthSchema.parse(throughRaw) : undefined;

  const rollforward = await getAccountRollforward(session.userId, id, {
    throughMonth: through,
  });
  return noStoreJson(rollforward);
});

export const PATCH = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req);
  if (oversized) return oversized;

  const { id } = await context.params;
  const body = patchSchema.parse(await req.json());
  const account = await updateBankAccount(session.userId, id, body);
  return noStoreJson({ account });
});

export const DELETE = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;

  const { id } = await context.params;
  const outcome = await removeBankAccount(session.userId, id);
  return noStoreJson({ ok: true, ...outcome });
});
