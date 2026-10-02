import { NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { guardWrite, noStoreJson } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import {
  hashIdempotencyPayload,
  idempotencyKeyFrom,
  withIdempotency,
} from "@/lib/idempotency";
import {
  createRecurringPurchase,
  createRecurringPurchaseSchema,
  listRecurringPurchases,
} from "@/lib/recurring-purchases";

/** Toistuvat ostolaskut: every template of the owner, paused ones included. */
export const GET = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  return noStoreJson({
    recurring: await listRecurringPurchases(session.userId),
  });
});

export const POST = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  const blocked = guardWrite(req);
  if (blocked) return blocked;

  const input = createRecurringPurchaseSchema.parse(await req.json());
  // A retried "Tallenna" returns the first template (and its first invoice) instead of a second one.
  const result = await withIdempotency(
    session.userId,
    "recurring-purchase.create",
    idempotencyKeyFrom(req),
    async (tx) => ({
      status: 201,
      body: {
        recurring: await createRecurringPurchase(
          session.userId,
          input,
          tx ?? undefined,
        ),
      },
    }),
    hashIdempotencyPayload(input),
  );
  return noStoreJson(result.body, { status: result.status });
});
