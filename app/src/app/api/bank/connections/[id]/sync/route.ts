import { NextRequest } from "next/server";
import { psuContextFromHeaders } from "@/lib/enablebanking/client";
import { respondToBankError } from "@/lib/enablebanking/respond";
import { enableBankingStatus, loadEnableBankingConfig } from "@/lib/enablebanking/signing";
import { syncBankConnection } from "@/lib/enablebanking/sync";
import { noStoreJson, rejectCrossSite } from "@/lib/http-security";
import { consumeRateLimit } from "@/lib/rate-limit";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const blocked = rejectCrossSite(req);
  if (blocked) return blocked;

  const session = await requireSession(req);
  if (!session?.userId) {
    return noStoreJson({ error: "Ei kirjautunut" }, { status: 401 });
  }
  const status = enableBankingStatus();
  if (!status.ready) {
    return noStoreJson(
      { error: status.message || "Pankkiyhteys ei ole käytössä." },
      { status: 503 }
    );
  }

  const { id } = await params;
  const limit = consumeRateLimit(`bank-sync:${session.userId}:${id}`, 12, 60 * 60 * 1000);
  if (!limit.allowed) {
    return noStoreJson(
      { error: "Liian monta hakua. Yritä hetken kuluttua uudelleen." },
      { status: 429 }
    );
  }

  try {
    loadEnableBankingConfig();
    const result = await syncBankConnection(session.userId, id, {
      attended: true,
      context: psuContextFromHeaders(req.headers),
    });
    return noStoreJson({
      ok: true,
      imported: result.imported,
      skipped: result.skipped,
      statementId: result.statementId,
      statementIds: result.statementIds,
      accounts: result.accounts,
    });
  } catch (error) {
    return respondToBankError(error);
  }
}
