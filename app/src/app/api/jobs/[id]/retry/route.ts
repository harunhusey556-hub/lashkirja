import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { noStoreJson, rejectCrossSite } from "@/lib/http-security";
import { processDocumentJob } from "@/lib/document-jobs";
import { isStuckRunning, runAfterResponse } from "@/lib/job-tracker";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireSession(req);
  if (!session) return noStoreJson({ error: "Ei kirjautunut" }, { status: 401 });
  const crossSite = rejectCrossSite(req);
  if (crossSite) return crossSite;
  const { id } = await params;

  const job = await prisma.backgroundJob.findFirst({
    where: { id, userId: session.userId! },
  });
  if (!job) return noStoreJson({ error: "Työtä ei löytynyt" }, { status: 404 });
  if (job.kind !== "document_analysis") {
    return noStoreJson({ error: "Tätä työtä ei voi yrittää uudelleen tästä" }, { status: 409 });
  }

  const retryable =
    job.status === "failed" ||
    job.status === "cancelled" ||
    (job.status === "running" && isStuckRunning(job.startedAt));
  if (!retryable) {
    return noStoreJson({ error: "Työ on jo käynnissä tai valmis" }, { status: 409 });
  }

  await prisma.backgroundJob.update({
    where: { id: job.id },
    data: {
      status: "pending",
      error: null,
      finishedAt: null,
      progressLabel: "Jonossa",
    },
  });
  runAfterResponse(() => processDocumentJob(job.id));
  return noStoreJson({ ok: true, jobId: job.id, status: "pending" });
}
