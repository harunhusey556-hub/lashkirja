import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/db";
import { reportEvent } from "@/lib/observe";

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
  };
}

const LOW_SPACE_BYTES = 50 * 1024 * 1024;

export function healthAuthOk(authorization: string | null, nodeEnv = process.env.NODE_ENV): boolean {
  const token = process.env.HEALTH_TOKEN?.trim();
  if (!token) return nodeEnv !== "production";
  return authorization === `Bearer ${token}`;
}

export function diskHealth(uploadsDir = path.join(process.cwd(), "data", "uploads")): HealthCheck {
  try {
    if (!fs.existsSync(uploadsDir)) return { ok: false, detail: "uploads-missing" };
    fs.accessSync(uploadsDir, fs.constants.W_OK);
    const stats = fs.statfsSync(uploadsDir);
    const free = stats.bavail * stats.bsize;
    if (free < LOW_SPACE_BYTES) return { ok: false, detail: "low-space" };
    return { ok: true, detail: "writable" };
  } catch {
    return { ok: false, detail: "unwritable" };
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
    const failedRecent = await prisma.backgroundJob.count({
      where: { kind: "bank_sync", status: "failed", finishedAt: { gte: since } },
    });
    bankJobs = {
      ok: failedRecent === 0,
      failedRecent,
      detail: failedRecent === 0 ? "ok" : "failed-recent",
    };
  } catch {
    bankJobs = { ok: false, failedRecent: -1, detail: "unavailable" };
  }

  const ok = db.ok && disk.ok && bankJobs.ok && mail.ok;
  const report: HealthReport = { ok, checks: { db, disk, mail, bankJobs } };
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
      ]
        .filter(Boolean)
        .join(","),
    });
  }
  return report;
}
