import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { reportEvent } from "@/lib/observe";
import { WORKER_STALE_AFTER_MS, workerHeartbeatPath } from "@/lib/worker-heartbeat";

export interface HealthCheck {
  ok: boolean;
  detail: string;
}

export interface HealthReport {
  ok: boolean;
  checks: {
    db: HealthCheck & { latencyMs?: number };
    disk: HealthCheck;
    mail: HealthCheck & { configured: boolean };
    bankJobs: HealthCheck & { failedRecent: number };
    worker: HealthCheck & { ageSeconds: number | null };
  };
}

// Early enough that the owner can still free space before a full disk breaks SQLite writes, uploads
// and the backup (its VACUUM INTO snapshot and zip need room too). 50 MB warned only when it was too late.
export const LOW_SPACE_BYTES = 5 * 1024 * 1024 * 1024;

export function healthAuthOk(authorization: string | null, nodeEnv = process.env.NODE_ENV): boolean {
  const token = process.env.HEALTH_TOKEN?.trim();
  if (!token) return nodeEnv !== "production";
  return authorization === `Bearer ${token}`;
}

export function diskHealth(
  uploadsDir = path.join(process.cwd(), "data", "uploads"),
  lowSpaceBytes = LOW_SPACE_BYTES
): HealthCheck {
  try {
    if (!fs.existsSync(uploadsDir)) return { ok: false, detail: "uploads-missing" };
    fs.accessSync(uploadsDir, fs.constants.W_OK);
    const stats = fs.statfsSync(uploadsDir);
    const free = stats.bavail * stats.bsize;
    if (free < lowSpaceBytes) return { ok: false, detail: "low-space" };
    return { ok: true, detail: "writable" };
  } catch {
    return { ok: false, detail: "unwritable" };
  }
}

/**
 * The background worker (scripts/worker.ts: mail, bank and document jobs) is a separate process, and
 * a web server that answers says nothing about it. It writes a heartbeat file every minute; this is
 * red when the file is missing or older than WORKER_STALE_AFTER_MS. Counted in `ok` like bankJobs,
 * and like bankJobs it must not make watchdog-prod.ps1 restart anything: it keys on db and disk only,
 * and a restart of the web server does not bring the worker back.
 * Only production runs a worker (run-prod.ps1); `next dev`, the tests and CI have none to wait for.
 */
export function workerHealth(
  now = new Date(),
  nodeEnv: string | undefined = process.env.NODE_ENV,
  heartbeatFile = workerHeartbeatPath()
): HealthCheck & { ageSeconds: number | null } {
  if (nodeEnv !== "production") return { ok: true, detail: "not-checked", ageSeconds: null };
  try {
    const beat = fs.statSync(heartbeatFile, { throwIfNoEntry: false });
    if (!beat) return { ok: false, detail: "never-started", ageSeconds: null };
    // A clock that stepped back would give a negative age.
    const ageMs = Math.max(0, now.getTime() - beat.mtimeMs);
    const ageSeconds = Math.floor(ageMs / 1000);
    return ageMs > WORKER_STALE_AFTER_MS
      ? { ok: false, detail: "stale", ageSeconds }
      : { ok: true, detail: "ok", ageSeconds };
  } catch {
    return { ok: false, detail: "unreadable", ageSeconds: null };
  }
}

export async function collectHealth(now = new Date()): Promise<HealthReport> {
  const dbStarted = Date.now();
  let db: HealthCheck & { latencyMs?: number };
  try {
    await prisma.$queryRaw`SELECT 1`;
    db = { ok: true, detail: "ok", latencyMs: Date.now() - dbStarted };
  } catch {
    db = { ok: false, detail: "unavailable" };
  }

  const disk = diskHealth();

  let mail: HealthCheck & { configured: boolean };
  try {
    const smtpEnv = Boolean(process.env.SMTP_HOST?.trim());
    const accounts = await prisma.imapAccount.count({ where: { smtpHost: { not: null } } });
    const configured = smtpEnv || accounts > 0;
    mail = { ok: true, configured, detail: configured ? "configured" : "not-configured" };
  } catch {
    mail = { ok: false, detail: "unavailable", configured: false };
  }

  let bankJobs: HealthCheck & { failedRecent: number };
  try {
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    // A connection counts only while its newest sync failed: a failure followed by a success
    // kept the check red for 24 h, and so did the jobs of a connection revoked since
    // (2026-10-09). The same rule as the owner's "sync failed" notification.
    const [jobs, connections] = await Promise.all([
      prisma.backgroundJob.findMany({
        where: { kind: "bank_sync", status: { in: ["failed", "done", "dismissed"] }, finishedAt: { gte: since } },
        orderBy: { createdAt: "desc" },
        select: { status: true, resourceId: true, createdAt: true },
      }),
      prisma.bankConnection.findMany({ select: { id: true, status: true, lastSuccessAt: true } }),
    ]);
    const byId = new Map(connections.map((connection) => [connection.id, connection]));
    const decided = new Set<string>();
    let failedRecent = 0;
    for (const job of jobs) {
      if (job.resourceId) {
        if (decided.has(job.resourceId)) continue;
        decided.add(job.resourceId);
      }
      if (job.status !== "failed") continue;
      const connection = job.resourceId ? byId.get(job.resourceId) : undefined;
      if (job.resourceId && (!connection || connection.status === "revoked")) continue;
      if (connection?.lastSuccessAt && connection.lastSuccessAt > job.createdAt) continue;
      failedRecent += 1;
    }
    bankJobs = {
      ok: failedRecent === 0,
      failedRecent,
      detail: failedRecent === 0 ? "ok" : "failed-recent",
    };
  } catch {
    bankJobs = { ok: false, failedRecent: -1, detail: "unavailable" };
  }

  const worker = workerHealth(now);

  const ok = db.ok && disk.ok && bankJobs.ok && mail.ok && worker.ok;
  const report: HealthReport = { ok, checks: { db, disk, mail, bankJobs, worker } };
  if (!ok) {
    reportEvent({
      kind: "health",
      message: "health degraded",
      status: 503,
      route: [
        db.ok ? "" : "db",
        disk.ok ? "" : "disk",
        mail.ok ? "" : "mail",
        bankJobs.ok ? "" : "bank",
        worker.ok ? "" : "worker",
      ]
        .filter(Boolean)
        .join(","),
    });
  }
  return report;
}
