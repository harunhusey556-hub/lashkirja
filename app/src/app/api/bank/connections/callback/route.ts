import { NextRequest } from "next/server";
import { z } from "zod";
import { completeBankConsent } from "@/lib/enablebanking/connect";
import { respondToBankError } from "@/lib/enablebanking/respond";
import { enableBankingStatus, loadEnableBankingConfig } from "@/lib/enablebanking/signing";
import { BANK_NOT_CONFIGURED_MESSAGE, logBankSetupGap } from "@/lib/enablebanking/public-status";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const callbackSchema = z.object({
  code: z.string().trim().min(1).max(2048),
  state: z.string().trim().min(16).max(512),
});

export async function POST(req: NextRequest) {
  const blocked = rejectCrossSite(req) || rejectOversizedContentLength(req);
  if (blocked) return blocked;

  const session = await requireSession(req);
  if (!session?.userId) {
    return noStoreJson({ error: "Ei kirjautunut" }, { status: 401 });
  }
  const status = enableBankingStatus();
  if (!status.ready) {
    logBankSetupGap(status);
    return noStoreJson({ error: BANK_NOT_CONFIGURED_MESSAGE }, { status: 503 });
  }

  try {
    const input = callbackSchema.parse(await req.json());
    loadEnableBankingConfig();
    const connection = await completeBankConsent(session.userId, input.code, input.state);
    return noStoreJson({ ok: true, connection });
  } catch (error) {
    return respondToBankError(error);
  }
}
