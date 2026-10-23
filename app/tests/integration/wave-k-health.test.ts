import { mkdirSync, rmSync, utimesSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET as health } from "@/app/api/health/route";
import { POST as observe } from "@/app/api/observe/route";
import { prisma } from "@/lib/db";
import { resetObserveForTests } from "@/lib/observe";
import { WORKER_STALE_AFTER_MS, workerHeartbeatPath, writeWorkerHeartbeat } from "@/lib/worker-heartbeat";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

let user: TestUser;
let cookie: string;

beforeEach(async () => {
  await resetDatabase();
  resetObserveForTests();
  user = await createUser();
  cookie = await sessionCookie(user);
  mkdirSync(path.join(process.cwd(), "data", "uploads"), { recursive: true });
});

describe("health and client errors", () => {
  it("separates db, disk, mail, and bank jobs without secrets", async () => {
    const response = await health(buildRequest("GET", "/api/health"));
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.ok).toBe(true);
    expect(body.checks.db.ok).toBe(true);
    expect(body.checks.disk.ok).toBe(true);
    expect(body.checks.mail.detail).toBe("not-configured");
    expect(body.checks.bankJobs).toEqual({ ok: true, failedRecent: 0, detail: "ok" });
    expect(JSON.stringify(body)).not.toMatch(/password|DATABASE_URL|SESSION_SECRET/i);

    await prisma.backgroundJob.create({
      data: {
        userId: user.id,
        kind: "bank_sync",
        status: "failed",
        title: "Pankki",
        error: "token super-secret",
        finishedAt: new Date(),
      },
    });
    const degraded = await health(buildRequest("GET", "/api/health"));
    expect(degraded.status).toBe(503);
    const degradedBody = await readJson(degraded);
    expect(degradedBody.checks.bankJobs.ok).toBe(false);
    expect(degradedBody.checks.bankJobs.failedRecent).toBe(1);
    expect(JSON.stringify(degradedBody)).not.toContain("super-secret");
  });

  it("records a client error without the query string", async () => {
    const response = await observe(
      buildRequest(
        "POST",
        "/api/observe",
        { message: "kaatui https://app.example/api/x?token=secret", source: "window" },
        { cookie, origin: "http://localhost:3000" }
      )
    );
    expect(response.status).toBe(200);
    const body = await readJson(response);
    expect(body.ok).toBe(true);
  });
});

describe("health and the background worker", () => {
  const heartbeat = workerHeartbeatPath();
  const authorized = { headers: { authorization: "Bearer ops-token" } };

  function asProduction() {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("HEALTH_TOKEN", "ops-token");
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(heartbeat, { force: true });
  });

  it("checks no worker where none runs (development, tests, CI)", async () => {
    const response = await health(buildRequest("GET", "/api/health"));
    expect(response.status).toBe(200);
    expect((await readJson(response)).checks.worker).toEqual({ ok: true, detail: "not-checked", ageSeconds: null });
  });

  it("is 200 in production while the worker beats", async () => {
    asProduction();
    writeWorkerHeartbeat();
    const response = await health(buildRequest("GET", "/api/health", undefined, authorized));
    const body = await readJson(response);
    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.checks.worker).toMatchObject({ ok: true, detail: "ok" });
  });

  // The watchdog restarts the web server only when db or disk is red (watchdog-prod.ps1). A stale
  // worker must leave both green, or it would restart a healthy server over and over.
  it("is 503 in production once the worker is stale, with db and disk untouched", async () => {
    asProduction();
    writeWorkerHeartbeat();
    const fresh = await readJson(await health(buildRequest("GET", "/api/health", undefined, authorized)));

    const staleAt = new Date(Date.now() - WORKER_STALE_AFTER_MS - 60_000);
    utimesSync(heartbeat, staleAt, staleAt);
    const response = await health(buildRequest("GET", "/api/health", undefined, authorized));
    const body = await readJson(response);
    expect(response.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.checks.worker).toMatchObject({ ok: false, detail: "stale" });
    expect(body.checks.db.ok).toBe(true);
    expect(body.checks.disk).toEqual(fresh.checks.disk);
    expect(body.checks.mail).toEqual(fresh.checks.mail);
    expect(body.checks.bankJobs).toEqual(fresh.checks.bankJobs);
  });

  it("is 503 in production when the worker never started", async () => {
    asProduction();
    const response = await health(buildRequest("GET", "/api/health", undefined, authorized));
    expect(response.status).toBe(503);
    expect((await readJson(response)).checks.worker).toMatchObject({ ok: false, detail: "never-started" });
  });

  it("goes green again on the next beat", async () => {
    asProduction();
    writeWorkerHeartbeat();
    const staleAt = new Date(Date.now() - WORKER_STALE_AFTER_MS - 60_000);
    utimesSync(heartbeat, staleAt, staleAt);
    expect((await health(buildRequest("GET", "/api/health", undefined, authorized))).status).toBe(503);
    writeWorkerHeartbeat();
    expect((await health(buildRequest("GET", "/api/health", undefined, authorized))).status).toBe(200);
  });
});
