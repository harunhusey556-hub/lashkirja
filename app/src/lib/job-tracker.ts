import { after } from "next/server";
import { prisma } from "./db";

const STUCK_RUNNING_MS = 10 * 60 * 1000;

export interface TrackedJobMeta {
  kind: string;
  title: string;
  detail?: string | null;
  resourceType?: string | null;
  resourceId?: string | null;
}

/** Records start and finish without changing the wrapped call's result or errors. */
export async function withTrackedJob<T>(
  userId: string,
  meta: TrackedJobMeta,
  fn: () => Promise<T>
): Promise<T> {
  let jobId: string | null = null;
  try {
    const job = await prisma.backgroundJob.create({
      data: {
        userId,
        kind: meta.kind,
        status: "running",
        title: meta.title,
        detail: meta.detail ?? null,
        resourceType: meta.resourceType ?? null,
        resourceId: meta.resourceId ?? null,
        startedAt: new Date(),
        progressLabel: "Käynnissä",
      },
    });
    jobId = job.id;
  } catch (error) {
    console.error("Job row was not stored", error);
  }

  try {
    const result = await fn();
    if (jobId) {
      await prisma.backgroundJob
        .update({
          where: { id: jobId },
          data: {
            status: "done",
            finishedAt: new Date(),
            progressLabel: "Valmis",
            error: null,
          },
        })
        .catch((error) => console.error("Job completion was not stored", error));
    }
    return result;
  } catch (error) {
    if (jobId) {
      const message = error instanceof Error ? error.message.slice(0, 300) : "Epäonnistui";
      await prisma.backgroundJob
        .update({
          where: { id: jobId },
          data: {
            status: "failed",
            finishedAt: new Date(),
            error: message,
            progressLabel: "Epäonnistui",
          },
        })
        .catch(() => {});
    }
    throw error;
  }
}

/** Runs after the response when Next can, otherwise starts the task without awaiting it. */
export function runAfterResponse(task: () => Promise<void>): void {
  const safe = () =>
    task().catch((error) => {
      console.error("Background job failed", error);
    });
  try {
    after(safe);
  } catch {
    void safe();
  }
}

export function isStuckRunning(startedAt: Date | null, now = Date.now()): boolean {
  if (!startedAt) return true;
  return now - startedAt.getTime() > STUCK_RUNNING_MS;
}
