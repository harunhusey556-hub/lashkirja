import { NextRequest } from "next/server";
import { z } from "zod";
import { listBankConnections, startBankConsent } from "@/lib/enablebanking/connect";
import { respondToBankError } from "@/lib/enablebanking/respond";
import { enableBankingStatus, loadEnableBankingConfig } from "@/lib/enablebanking/signing";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { consumeRateLimit } from "@/lib/rate-limit";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

const startSchema = z.object({
  aspspName: z.string().trim().min(1).max(120),
  aspspCountry: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/)
    .default("FI"),
  psuType: z.enum(["personal", "business"]),
  client: z.enum(["web", "app"]).optional().default("web"),
});

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session?.userId) {
    return noStoreJson({ error: "Ei kirjautunut" }, { status: 401 });
  }
  const status = enableBankingStatus();
  try {
    const connections = await listBankConnections(session.userId);
    return noStoreJson({
      enabled: status.enabled,
      ready: status.ready,
      message: status.message,
      connections,
    });
  } catch (error) {
    return respondToBankError(error);
  }
}

export async function POST(req: NextRequest) {
  const blocked = rejectCrossSite(req) || rejectOversizedContentLength(req);
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

  const limit = consumeRateLimit(`bank-start:${session.userId}`, 8, 60 * 60 * 1000);
  if (!limit.allowed) {
    return noStoreJson(
      { error: "Liian monta yhdistämisyritystä. Yritä myöhemmin uudelleen." },
      { status: 429 }
    );
  }

  try {
    const input = startSchema.parse(await req.json());
    loadEnableBankingConfig();
    const started = await startBankConsent(session.userId, input);
    return noStoreJson({ url: started.url, connectionId: started.connectionId });
  } catch (error) {
    return respondToBankError(error);
  }
}
