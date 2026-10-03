import { NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import {
  deleteEmailTemplate,
  updateEmailTemplate,
  updateTemplateSchema,
} from "@/lib/invoice-email-templates";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * PATCH `{ name?, subject?, body?, kind?, isDefault? }` -> `{ template }`.
 * `isDefault: true` makes this the one default of its kind. Another owner's
 * template answers 404, as if it did not exist.
 */
export const PATCH = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req);
  if (oversized) return oversized;
  const { id } = await context.params;
  const template = await updateEmailTemplate(session.userId, id, updateTemplateSchema.parse(await req.json()));
  return noStoreJson({ template });
});

/** DELETE -> `{ ok: true }`. Invoices already sent keep the text they went out with. */
export const DELETE = withErrorHandler(async (req: NextRequest, context: RouteContext) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const { id } = await context.params;
  await deleteEmailTemplate(session.userId, id);
  return noStoreJson({ ok: true });
});
