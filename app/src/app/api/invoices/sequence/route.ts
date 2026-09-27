import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { peekInvoiceNumber, setInvoiceStartingNumber } from "@/lib/invoice-sequence";

const bodySchema = z.object({ startingNumber: z.number().int() }).strict();

export const GET = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  return noStoreJson({ nextNumber: await peekInvoiceNumber(session.userId) });
});

export const PUT = withErrorHandler(async (req: NextRequest) => {
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();
  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req);
  if (oversized) return oversized;
  const body = bodySchema.parse(await req.json());
  const nextNumber = await setInvoiceStartingNumber(session.userId, body.startingNumber);
  return noStoreJson({ nextNumber });
});
