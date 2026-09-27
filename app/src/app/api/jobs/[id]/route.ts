import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { noStoreJson } from "@/lib/http-security";
import { extractedFromJobPayload } from "@/lib/document-jobs";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireSession(req);
  if (!session) return noStoreJson({ error: "Ei kirjautunut" }, { status: 401 });
  const { id } = await params;

  const job = await prisma.backgroundJob.findFirst({
    where: { id, userId: session.userId! },
    select: {
      id: true,
      kind: true,
      status: true,
      title: true,
      detail: true,
      error: true,
      progressLabel: true,
      resourceType: true,
      resourceId: true,
      payload: true,
      createdAt: true,
      startedAt: true,
      finishedAt: true,
    },
  });
  if (!job) return noStoreJson({ error: "Työtä ei löytynyt" }, { status: 404 });

  const { payload, ...safe } = job;
  return noStoreJson({
    job: {
      ...safe,
      extracted: job.status === "done" ? extractedFromJobPayload(payload) : null,
    },
  });
}
