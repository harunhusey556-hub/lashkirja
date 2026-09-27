import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite } from "@/lib/http-security";
import { findActiveVendorRule, normalizeVendorKey, saveVendorRule } from "@/lib/vendor-rules";

const saveSchema = z.object({
  vendor: z.string().trim().min(1).max(300),
  category: z.string().trim().min(1).max(100),
});

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return noStoreJson({ error: "Ei kirjautunut" }, { status: 401 });
  const vendor = new URL(req.url).searchParams.get("vendor") ?? "";
  if (!normalizeVendorKey(vendor)) return noStoreJson({ rule: null });
  const rule = await findActiveVendorRule(session.userId!, vendor);
  if (!rule?.active) return noStoreJson({ rule: null });
  return noStoreJson({
    rule: { vendor: rule.vendor, category: rule.category, active: true },
  });
}

export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return noStoreJson({ error: "Ei kirjautunut" }, { status: 401 });
  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const parsed = saveSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return noStoreJson({ error: "Virheelliset tiedot" }, { status: 400 });
  const rule = await saveVendorRule(session.userId!, parsed.data.vendor, parsed.data.category);
  return noStoreJson({
    ok: true,
    rule: { vendor: rule.vendor, category: rule.category, active: rule.active },
  });
}
