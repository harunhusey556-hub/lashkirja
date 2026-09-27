import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite, rejectOversizedContentLength } from "@/lib/http-security";

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
    where: {
      id,
      userId: session.userId!,
      kind: "document_analysis",
      status: { in: ["pending", "running"] },
    },
    data: {
      status: "cancelled",
      attemptToken: null,
      finishedAt: new Date(),
      progressLabel: "Peruttu",
    },
  });
  if (updated.count === 0) {
    return noStoreJson({ error: "Työtä ei voitu perua" }, { status: 409 });
  }
  return noStoreJson({ ok: true, status: "cancelled" });
}
