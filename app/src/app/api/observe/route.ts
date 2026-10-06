import { NextRequest } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";
import { allowClientReport, publicErrorMessage, reportEvent } from "@/lib/observe";

const bodySchema = z
  .object({
    message: z.string().trim().min(1).max(500),
    source: z.enum(["window", "rejection", "native"]),
  })
  .strict();

export async function POST(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return noStoreJson({ error: "Ei kirjautunut" }, { status: 401 });
  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req);
  if (oversized) return oversized;
  if (!allowClientReport()) return noStoreJson({ ok: true, dropped: true });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return noStoreJson({ error: "Virheellinen pyyntö" }, { status: 400 });

  reportEvent({
    kind: "client_error",
    message: publicErrorMessage(parsed.data.message),
    route: parsed.data.source,
  });
  return noStoreJson({ ok: true });
}
