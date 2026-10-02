import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { hashIdempotencyPayload, idempotencyKeyFrom, withIdempotency } from "@/lib/idempotency";
import { createPurchaseInvoice, listPurchaseInvoices } from "@/lib/purchase-invoices";
import { isoDateSchema, monthSchema, moneySchema, nonnegativeMoneySchema } from "@/lib/validation";

const createSchema = z.object({
  supplierName: z.string().trim().min(1, "Toimittajan nimi puuttuu").max(120),
  supplierBusinessId: z.string().trim().max(20).nullish(),
  supplierIban: z.string().trim().max(42).nullish(),
  invoiceNumber: z.string().trim().max(40).nullish(),
  reference: z.string().trim().max(30).nullish(),
  issueDate: isoDateSchema,
  dueDate: isoDateSchema,
  gross: moneySchema,
  vat: nonnegativeMoneySchema.optional(),
  category: z.string().trim().max(60).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  receiptId: z.string().uuid().nullish(),
});

const statusFilter = z.enum(["all", "open", "paid", "cancelled", "overdue"]);

export const GET = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const params = req.nextUrl.searchParams;
  const rawStatus = params.get("status");
  const rawMonth = params.get("month");
  const result = await listPurchaseInvoices(session.userId, {
    status: rawStatus ? statusFilter.parse(rawStatus) : undefined,
    month: rawMonth ? monthSchema.parse(rawMonth) : undefined,
  });
  return noStoreJson(result);
});

export const POST = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req);
  if (oversized) return oversized;

  const input = createSchema.parse(await req.json());
  // The app sends an Idempotency-Key: a retried "Lisää" returns the first invoice instead of a second one.
  const result = await withIdempotency(
    session.userId,
    "purchase-invoice.create",
    idempotencyKeyFrom(req),
    async (tx) => ({
      status: 201,
      body: { invoice: await createPurchaseInvoice(session.userId, input, tx ?? undefined) },
    }),
    hashIdempotencyPayload(input)
  );
  return noStoreJson(result.body, { status: result.status });
});
