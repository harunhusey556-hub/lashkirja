import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { UnauthorizedError, ValidationError, withErrorHandler } from "@/lib/api-errors";
import {
  deleteMonthlyBalance,
  getAccountRollforward,
  upsertMonthlyBalance,
} from "@/lib/bank-accounts";
import { monthSchema, moneySchema } from "@/lib/validation";

const upsertSchema = z.object({
  month: monthSchema,
  closingBalance: moneySchema,
  note: z.string().trim().max(200).nullish(),
});

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const { id } = await context.params;
  const rollforward = await getAccountRollforward(session.userId, id);
  return noStoreJson({ months: rollforward.months });
});

export const PUT = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req);
  if (oversized) return oversized;

  const { id } = await context.params;
  const body = upsertSchema.parse(await req.json());
  const balance = await upsertMonthlyBalance(session.userId, id, body);
  return noStoreJson({ balance });
});

export const DELETE = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;

  const { id } = await context.params;
  const month = req.nextUrl.searchParams.get("month");
  if (!month || !monthSchema.safeParse(month).success) {
    throw new ValidationError("Kuukausi puuttuu tai on virheellinen (YYYY-MM).");
  }

  await deleteMonthlyBalance(session.userId, id, month);
  return noStoreJson({ ok: true });
});
