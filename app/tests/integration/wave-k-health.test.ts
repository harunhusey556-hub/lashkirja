import { mkdirSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { GET as health } from "@/app/api/health/route";
import { POST as observe } from "@/app/api/observe/route";
import { prisma } from "@/lib/db";
import { resetObserveForTests } from "@/lib/observe";
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