import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { createCatalogItem, listCatalog } from "@/lib/catalog";
import { moneySchema } from "@/lib/validation";

const createSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    unit: z.string().trim().max(16).optional(),
    unitPrice: moneySchema,
    vatRate: z.number().finite().min(0).max(100),
  })
  .strict();

export const GET = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  return noStoreJson({ items: await listCatalog(session.userId) });
});

export const POST = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req);
  if (oversized) return oversized;
  const item = await createCatalogItem(session.userId, createSchema.parse(await req.json()));
  return noStoreJson({ item }, { status: 201 });
});
