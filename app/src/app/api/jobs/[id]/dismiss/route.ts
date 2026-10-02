import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";

/**
 * "Kuittaa": the owner has seen a failed job (a bank sync before accounts were chosen, say) and
 * it is dealt with. It leaves "Tuonnit ja virheet" and Koti's count, and the health check's
 * bank-job figure stops counting it.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireSession(req);
  if (!session) return noStoreJson({ error: "Ei kirjautunut" }, { status: 401 });
  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const oversized = rejectOversizedContentLength(req);
  if (oversized) return oversized;
  const { id } = await params;

  const updated = await prisma.backgroundJob.updateMany({
    where: { id, userId: session.userId!, status: "failed" },
    data: { status: "dismissed", progressLabel: "Kuitattu" },
  });
  if (updated.count === 0) {
    return noStoreJson({ error: "Virhettä ei voitu kuitata" }, { status: 409 });
  }
  return noStoreJson({ ok: true, status: "dismissed" });
}
