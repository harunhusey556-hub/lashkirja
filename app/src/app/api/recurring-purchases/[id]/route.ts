import { NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { guardWrite, noStoreJson } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import {
  deleteRecurringPurchase,
  getRecurringPurchase,
  patchRecurringPurchaseSchema,
  updateRecurringPurchase,
} from "@/lib/recurring-purchases";

type RouteContext = { params: Promise<{ id: string }> };

export const GET = withErrorHandler(
  async (req: NextRequest, context: RouteContext) => {
    const session = await requireSession(req);
    if (!session) throw new UnauthorizedError();
    const { id } = await context.params;
    return noStoreJson({
      recurring: await getRecurringPurchase(session.userId, id),
    });
  },
);

/** Any create field plus `active`; null clears an optional field. */
export const PATCH = withErrorHandler(
  async (req: NextRequest, context: RouteContext) => {
    const session = await requireSession(req);
    if (!session) throw new UnauthorizedError();
    const blocked = guardWrite(req);
    if (blocked) return blocked;

    const { id } = await context.params;
    const input = patchRecurringPurchaseSchema.parse(await req.json());
    return noStoreJson({
      recurring: await updateRecurringPurchase(session.userId, id, input),
    });
  },
);

/** Removes the template; the invoices it already created stay. */
export const DELETE = withErrorHandler(
  async (req: NextRequest, context: RouteContext) => {
    const session = await requireSession(req);
    if (!session) throw new UnauthorizedError();
    const blocked = guardWrite(req);
    if (blocked) return blocked;

    const { id } = await context.params;
    await deleteRecurringPurchase(session.userId, id);
    return noStoreJson({ ok: true });
  },
);
