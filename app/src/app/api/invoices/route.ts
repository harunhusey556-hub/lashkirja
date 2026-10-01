import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { hashIdempotencyPayload, idempotencyKeyFrom, withIdempotency } from "@/lib/idempotency";
import { createInvoice, listInvoices } from "@/lib/sales-invoices";
import { reminderWaitsFor } from "@/lib/reminder-waits";
import { isoDateSchema, moneySchema, periodScopeSchema } from "@/lib/validation";

const lineSchema = z.object({
  description: z.string().trim().min(1, "Rivin kuvaus puuttuu").max(200),
  quantity: z.number().finite(),
  unit: z.string().trim().max(16).optional(),
  unitPrice: moneySchema,
  vatRate: z.number().finite().min(0).max(100),
});

const createSchema = z
  .object({
    customerId: z.string().uuid(),
    issueDate: isoDateSchema,
    paymentTermDays: z.number().int().min(0).max(365).optional(),
    dueDate: isoDateSchema.optional(),
    notes: z.string().trim().max(2000).nullish(),
    lines: z.array(lineSchema).min(1).max(200),
  })
  .strict();

const statusFilter = z.enum(["all", "draft", "sent", "paid", "credited", "overdue"]);

export const GET = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const params = req.nextUrl.searchParams;
  const rawStatus = params.get("status");
  const rawMonth = params.get("month");
  const result = await listInvoices(session.userId, {
    status: rawStatus ? statusFilter.parse(rawStatus) : undefined,
    customerId: params.get("customerId") ?? undefined,
    month: rawMonth ? periodScopeSchema.parse(rawMonth) : undefined,
    search: params.get("search")?.slice(0, 80) || undefined,
  });
  // An overdue invoice that was reminded lately cannot be reminded again yet:
  // the list hides "Muistuta" for it instead of offering a refused action.
  const waits = await reminderWaitsFor(
    session.userId,
    result.invoices.filter((invoice) => invoice.displayStatus === "overdue").map((invoice) => invoice.id)
  );
  return noStoreJson({
    ...result,
    invoices: result.invoices.map((invoice) => ({
      ...invoice,
      nextReminderAt: waits.get(invoice.id) ?? null,
    })),
  });
});

export const POST = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req);
  if (oversized) return oversized;

  const input = createSchema.parse(await req.json());
  const result = await withIdempotency(
    session.userId,
    "invoice.create",
    idempotencyKeyFrom(req),
    async (tx) => ({
      status: 201,
      body: { invoice: await createInvoice(session.userId, input, tx ?? undefined) },
    }),
    hashIdempotencyPayload(input)
  );
  return noStoreJson(result.body, { status: result.status });
});
