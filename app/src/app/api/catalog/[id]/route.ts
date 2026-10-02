import { NextRequest } from "next/server";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { archiveCatalogItem } from "@/lib/catalog";

/** Removes a product from the picker. It is archived, so invoices that used it keep their lines. */
export const DELETE = withErrorHandler(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const { id } = await params;
  await archiveCatalogItem(session.userId, id);
  return noStoreJson({ ok: true });
});
