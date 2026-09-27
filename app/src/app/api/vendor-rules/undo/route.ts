import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { undoVendorRule } from "@/lib/vendor-rules";

const undoSchema = z.object({
  vendor: z.string().trim().min(1).max(300),
});

export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return noStoreJson({ error: "Ei kirjautunut" }, { status: 401 });
  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req);
  if (oversized) return oversized;
  const parsed = undoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return noStoreJson({ error: "Virheelliset tiedot" }, { status: 400 });
  const rule = await undoVendorRule(session.userId!, parsed.data.vendor);
  if (!rule) return noStoreJson({ error: "Sääntöä ei löytynyt" }, { status: 404 });
  return noStoreJson({ ok: true, active: rule.active });
}
