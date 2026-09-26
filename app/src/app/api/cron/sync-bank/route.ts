import { NextRequest } from "next/server";
import { authorizationMatches, enableBankingStatus } from "@/lib/enablebanking/signing";
import { syncDueBankConnections } from "@/lib/enablebanking/sync";
import { noStoreJson } from "@/lib/http-security";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim() || "";
  if (!authorizationMatches(req.headers.get("authorization"), secret)) {
    return noStoreJson({ error: "Unauthorized" }, { status: 401 });
  }

  const status = enableBankingStatus();
  if (!status.ready) {
    return noStoreJson({
      ok: true,
      skipped: true,
      message: status.message || "Pankkiyhteys ei ole käytössä.",
    });
  }

  try {
    const result = await syncDueBankConnections();
    return noStoreJson({ ok: true, ...result });
  } catch (error) {
    console.error("Bank cron failed", error instanceof Error ? error.name : "unknown");
    return noStoreJson({ error: "Pankkien haku epäonnistui." }, { status: 500 });
  }
}
