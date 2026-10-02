import { NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { guardWrite, noStoreJson } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import {
  hashIdempotencyPayload,
  idempotencyKeyFrom,
  withIdempotency,
} from "@/lib/idempotency";
import { runRecurringPurchaseNow } from "@/lib/recurring-purchases";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * "Luo nyt": creates the current period's purchase invoice if it is not there
 * yet. Safe to call twice: the second answer is { created: false }.
 */
export const POST = withErrorHandler(
  async (req: NextRequest, context: RouteContext) => {
    const session = await requireSession(req);
    if (!session) throw new UnauthorizedError();
    const blocked = guardWrite(req);
    if (blocked) return blocked;

    const { id } = await context.params;
    const result = await withIdempotency(
      session.userId,
      "recurring-purchase.run",
      idempotencyKeyFrom(req),
      async (tx) => ({
        status: 200,
        body: await runRecurringPurchaseNow(
          session.userId,
          id,
          tx ?? undefined,
        ),
      }),
      hashIdempotencyPayload({ id }),
    );
    return noStoreJson(result.body, { status: result.status });
  },
);
