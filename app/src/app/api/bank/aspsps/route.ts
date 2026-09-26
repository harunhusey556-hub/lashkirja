import { NextRequest } from "next/server";
import { EnableBankingClient } from "@/lib/enablebanking/client";
import { respondToBankError } from "@/lib/enablebanking/respond";
import { enableBankingStatus, loadEnableBankingConfig } from "@/lib/enablebanking/signing";
import { noStoreJson } from "@/lib/http-security";
import { requireSession } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session?.userId) {
    return noStoreJson({ error: "Ei kirjautunut" }, { status: 401 });
  }

  const status = enableBankingStatus();
  if (!status.enabled) {
    return noStoreJson({ aspsps: [], enabled: false });
  }
  if (!status.ready) {
    return noStoreJson(
      { error: status.message || "Pankkiyhteys ei ole käytössä.", aspsps: [] },
      { status: 503 }
    );
  }

  const country = req.nextUrl.searchParams.get("country")?.trim().toUpperCase() || "FI";
  const psuType = req.nextUrl.searchParams.get("psuType")?.trim();
  if (!/^[A-Z]{2}$/.test(country)) {
    return noStoreJson({ error: "Maakoodi on virheellinen." }, { status: 400 });
  }
  if (psuType && psuType !== "personal" && psuType !== "business") {
    return noStoreJson({ error: "Asiakastyyppi on virheellinen." }, { status: 400 });
  }

  try {
    loadEnableBankingConfig();
    const client = new EnableBankingClient();
    const aspsps = await client.listAspsps(country, psuType || undefined);
    return noStoreJson({
      aspsps: aspsps
        .map((aspsp) => ({
          name: aspsp.name,
          country: aspsp.country,
          logo: aspsp.logo || null,
          psuTypes: aspsp.psu_types ?? [],
          maximumConsentValidity: aspsp.maximum_consent_validity ?? null,
          beta: Boolean(aspsp.beta),
        }))
        .sort((a, b) => a.name.localeCompare(b.name, "fi")),
    });
  } catch (error) {
    return respondToBankError(error);
  }
}
