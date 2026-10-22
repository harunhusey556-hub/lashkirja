import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workerHealth } from "@/lib/health";
import {
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_STALE_AFTER_MS,
  workerHeartbeatPath,
  writeWorkerHeartbeat,
} from "@/lib/worker-heartbeat";

const dirs: string[] = [];

function heartbeatFile(): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "lashkirja-worker-"));
  dirs.push(dir);
  return path.join(dir, "data", "worker-heartbeat");
}

/** Sets the beat's age the way time does: through the file's modification time. */
function beatAged(file: string, ageMs: number, now: Date): void {
  writeWorkerHeartbeat(file);
  const when = new Date(now.getTime() - ageMs);
  fs.utimesSync(file, when, when);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("worker heartbeat", () => {
  it("lives under data/ of the working directory, where the web server and the worker both run", () => {
    expect(workerHeartbeatPath()).toBe(path.join(process.cwd(), "data", "worker-heartbeat"));
  });

  it("is written into a data directory that does not exist yet", () => {
    const file = heartbeatFile();
    writeWorkerHeartbeat(file);
    expect(fs.readFileSync(file, "utf8")).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z pid=\d+\n$/);
  });

  it("beats several times before the stale limit, so one late beat is not a dead worker", () => {
    expect(WORKER_STALE_AFTER_MS / WORKER_HEARTBEAT_INTERVAL_MS).toBeGreaterThanOrEqual(3);
  });
});

describe("workerHealth in production", () => {
  const now = new Date("2026-10-22T12:00:00Z");

  it("is ok right after a beat", () => {
    const file = heartbeatFile();
    writeWorkerHeartbeat(file);
    const health = workerHealth(new Date(), "production", file);
    expect(health).toMatchObject({ ok: true, detail: "ok" });
    expect(health.ageSeconds).toBeLessThan(5);
  });

  it("stays ok up to the stale limit and is stale just after it", () => {
    const file = heartbeatFile();
    beatAged(file, WORKER_STALE_AFTER_MS, now);
    expect(workerHealth(now, "production", file)).toEqual({ ok: true, detail: "ok", ageSeconds: 300 });
    beatAged(file, WORKER_STALE_AFTER_MS + 1000, now);
    expect(workerHealth(now, "production", file)).toEqual({ ok: false, detail: "stale", ageSeconds: 301 });
  });

  it("is stale for a worker that stopped an hour ago", () => {
    const file = heartbeatFile();
    beatAged(file, 60 * 60 * 1000, now);
    expect(workerHealth(now, "production", file)).toEqual({ ok: false, detail: "stale", ageSeconds: 3600 });
  });

  it("recovers on the next beat", () => {
    const file = heartbeatFile();
    beatAged(file, 60 * 60 * 1000, now);
    expect(workerHealth(now, "production", file).ok).toBe(false);
    writeWorkerHeartbeat(file);
    expect(workerHealth(new Date(), "production", file).ok).toBe(true);
  });

  it("is red when the worker never wrote a beat", () => {
    expect(workerHealth(now, "production", heartbeatFile())).toEqual({ ok: false, detail: "never-started", ageSeconds: null });
  });

  it("does not count a clock that stepped back as a stale worker", () => {
    const file = heartbeatFile();
    beatAged(file, -2 * 60 * 1000, now);
    expect(workerHealth(now, "production", file)).toEqual({ ok: true, detail: "ok", ageSeconds: 0 });
  });

  it("reports a heartbeat it cannot read as red, without throwing", () => {
    const file = heartbeatFile();
    writeWorkerHeartbeat(file);
    vi.spyOn(fs, "statSync").mockImplementation(() => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    });
    expect(workerHealth(now, "production", file)).toEqual({ ok: false, detail: "unreadable", ageSeconds: null });
  });
});

describe("workerHealth outside production", () => {
  const now = new Date("2026-10-22T12:00:00Z");

  // `next dev`, the test suites and CI run no worker; a file left behind by an old local run must
  // not turn their health check red either.
  it.each(["development", "test"])("checks nothing in %s", (nodeEnv) => {
    const missing = heartbeatFile();
    expect(workerHealth(now, nodeEnv, missing)).toEqual({ ok: true, detail: "not-checked", ageSeconds: null });
    const old = heartbeatFile();
    beatAged(old, 7 * 24 * 60 * 60 * 1000, now);
    expect(workerHealth(now, nodeEnv, old)).toEqual({ ok: true, detail: "not-checked", ageSeconds: null });
  });
});
