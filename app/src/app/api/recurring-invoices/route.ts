import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import {
  countDueRecurringInvoices,
  createRecurringInvoice,
  listRecurringInvoices,
} from "@/lib/recurring-invoices";
import { isoDateSchema, moneySchema } from "@/lib/validation";

const lineSchema = z.object({
  description: z.string().trim().min(1, "Rivin kuvaus puuttuu").max(200),
  quantity: z.number().finite(),
  unit: z.string().trim().max(16).optional(),
  unitPrice: moneySchema,
  vatRate: z.number().finite().min(0).max(100),
});

const createSchema = z.object({
  customerId: z.string().uuid(),
  name: z.string().trim().max(120).nullish(),
  interval: z.enum(["monthly", "quarterly", "yearly"]),
  anchorDay: z.number().int().min(1).max(31),
  startDate: isoDateSchema,
  endDate: isoDateSchema.nullish(),
  paymentTermDays: z.number().int().min(0).max(365).optional(),
  notes: z.string().trim().max(2000).nullish(),
  autoSend: z.boolean().optional(),
  active: z.boolean().optional(),
  lines: z.array(lineSchema).min(1).max(200),
});

export const GET = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const includeInactive = req.nextUrl.searchParams.get("includeInactive") === "1";
  const [recurring, dueNow] = await Promise.all([
    listRecurringInvoices(session.userId, { includeInactive }),
    countDueRecurringInvoices(session.userId),
  ]);
  return noStoreJson({ recurring, dueNow });
});

export const POST = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req);
  if (oversized) return oversized;

  const recurring = await createRecurringInvoice(
    session.userId,
    createSchema.parse(await req.json())
  );
  return noStoreJson({ recurring }, { status: 201 });
});
