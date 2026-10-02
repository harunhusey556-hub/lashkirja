import { NextRequest } from "next/server";
import { z } from "zod";
import { psuContextFromHeaders } from "@/lib/enablebanking/client";
import { revokeBankConnection, updateBankConnection } from "@/lib/enablebanking/connect";
import { respondToBankError } from "@/lib/enablebanking/respond";
import { enableBankingStatus, loadEnableBankingConfig } from "@/lib/enablebanking/signing";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Either or both: which accounts are in the books, and from which day history
 * is fetched ("YYYY-MM-DD"). The day's own checks (not in the future, not
 * beyond the bank's limit) answer in Finnish from updateBankConnection.
 */
const updateSchema = z
  .object({
    accounts: z
      .array(
        z.object({
          id: z.string().uuid(),
          inScope: z.boolean(),
        })
      )
      .min(1)
      .max(100)
      .optional(),
    historyFrom: z.string().trim().max(10).optional(),
  })
  .refine((value) => value.accounts !== undefined || value.historyFrom !== undefined);

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const blocked = rejectCrossSite(req) || rejectOversizedContentLength(req);
  if (blocked) return blocked;

  const session = await requireSession(req);
  if (!session?.userId) {
    return noStoreJson({ error: "Ei kirjautunut" }, { status: 401 });
  }

  try {
    const { id } = await params;
    const input = updateSchema.parse(await req.json());
    const connection = await updateBankConnection(session.userId, id, input);
    return noStoreJson({ connection });
  } catch (error) {
    return respondToBankError(error);
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const blocked = rejectCrossSite(req);
  if (blocked) return blocked;

  const session = await requireSession(req);
  if (!session?.userId) {
    return noStoreJson({ error: "Ei kirjautunut" }, { status: 401 });
  }
  try {
    const { id } = await params;
    if (enableBankingStatus().ready) loadEnableBankingConfig();
    await revokeBankConnection(session.userId, id, psuContextFromHeaders(req.headers));
    return noStoreJson({ ok: true });
  } catch (error) {
    return respondToBankError(error);
  }
}
