import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { requireSession } from "@/lib/session";
import { noStoreJson } from "@/lib/http-security";
import { jobTitle } from "@/lib/display-titles";

export async function GET(req: NextRequest) {
  const session = await requireSession(req);
  if (!session) return noStoreJson({ error: "Ei kirjautunut" }, { status: 401 });

  const jobs = await prisma.backgroundJob.findMany({
    where: { userId: session.userId! },
    orderBy: { createdAt: "desc" },
    take: 50,
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
      createdAt: true,
      startedAt: true,
      finishedAt: true,
    },
  });

  // A job is named by what it is, never by the file it read (F28).
  return noStoreJson({ jobs: jobs.map((job) => ({ ...job, title: jobTitle(job) })) });
}
