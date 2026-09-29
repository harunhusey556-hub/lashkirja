import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { guardWrite, noStoreJson } from "@/lib/http-security";
import { UnauthorizedError, withErrorHandler } from "@/lib/api-errors";
import { isFilingPeriod, updateVatFiling } from "@/lib/vat-filing";

const bodySchema = z
  .object({
    period: z.string().refine(isFilingPeriod, "Virheellinen ALV-kausi"),
    filed: z.boolean().optional(),
    paid: z.boolean().optional(),
  })
  .refine((body) => body.filed !== undefined || body.paid !== undefined, "Ei muutosta");

/**
 * "Merkitse ilmoitetuksi" / "Merkitse maksetuksi" (FP-13). The owner files in
 * OmaVero; this records that it was done. `filed: false` undoes both.
 */
export const PATCH = withErrorHandler(async (req: NextRequest) => {
  const blocked = guardWrite(req);
  if (blocked) return blocked;
  const session = await requireSession(req);
  if (!session) throw new UnauthorizedError();

  const body = bodySchema.parse(await req.json());
  const filing = await updateVatFiling(session.userId, body.period, { filed: body.filed, paid: body.paid });
  return noStoreJson({ period: body.period, filing });
});
