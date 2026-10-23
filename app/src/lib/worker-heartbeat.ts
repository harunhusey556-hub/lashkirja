import fs from "node:fs";
import path from "node:path";

// The worker (scripts/worker.ts) and the web server run from the same working directory
// (run-prod.ps1), so a file under data/ is the one thing both see without a schema change.

/**
 * How often the worker writes its beat. A timer of its own, not the 10-minute sync cycle: a mail or
 * OCR cycle can run for many minutes without the worker being dead.
 */
export const WORKER_HEARTBEAT_INTERVAL_MS = 60 * 1000;

/**
 * Five missed beats. The watchdog probes every 5 minutes, so this is the first probe that can see a
 * worker that stopped; a machine that slept shows stale for at most one beat after it wakes.
 */
export const WORKER_STALE_AFTER_MS = 5 * 60 * 1000;

export function workerHeartbeatPath(dataDir = path.join(process.cwd(), "data")): string {
  return path.join(dataDir, "worker-heartbeat");
}

/**
 * Health judges the file's modification time, not its text, so a read that lands in the middle of a
 * write still sees a valid age. The text is only there for a person who opens the file.
 */
export function writeWorkerHeartbeat(file = workerHeartbeatPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${new Date().toISOString()} pid=${process.pid}\n`);
}
