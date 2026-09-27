import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { createCustomer, listCustomers } from "@/lib/customers";
import { hashIdempotencyPayload, idempotencyKeyFrom, withIdempotency } from "@/lib/idempotency";

const createSchema = z.object({
  name: z.string().trim().min(1, "Asiakkaan nimi puuttuu").max(120),
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
});

export const GET = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const params = req.nextUrl.searchParams;
  const customers = await listCustomers(session.userId, {
    includeArchived: params.get("includeArchived") === "1",
    search: params.get("search") ?? undefined,
  });
  return noStoreJson({ customers });
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
    "customer.create",
    idempotencyKeyFrom(req),
    async (tx) => ({
      status: 201,
      body: { customer: await createCustomer(session.userId, input, tx ?? undefined) },
    }),
    hashIdempotencyPayload(input)
  );
  return noStoreJson(result.body, { status: result.status });
});
