import { beforeEach, describe, expect, it } from "vitest";
import { POST as dismissJob } from "@/app/api/jobs/[id]/dismiss/route";
import { collectHealth } from "@/lib/health";
import { prisma } from "@/lib/db";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

/** "Kuittaa" on a failed job: it leaves the owner's lists and no longer reddens the health check. */

let user: TestUser;
let cookie: string;

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

function failedJob(userId: string, status = "failed") {
  return prisma.backgroundJob.create({
    data: { userId, kind: "bank_sync", status, title: "Pankki", error: "Valitse ainakin yksi tili ennen hakua.", finishedAt: new Date() },
  });
}

const dismiss = (id: string, withCookie = cookie) =>
  dismissJob(buildRequest("POST", `/api/jobs/${id}/dismiss`, {}, { cookie: withCookie }), { params: Promise.resolve({ id }) });

describe("POST /api/jobs/:id/dismiss", () => {
  it("marks a failed job dismissed and clears the bank health check", async () => {
    const job = await failedJob(user.id);
    expect((await collectHealth()).checks.bankJobs.ok).toBe(false);

    const response = await dismiss(job.id);
    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ ok: true, status: "dismissed" });
    expect((await prisma.backgroundJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("dismissed");
    expect((await collectHealth()).checks.bankJobs.ok).toBe(true);
  });

  it("refuses a job that has not failed", async () => {
    const job = await failedJob(user.id, "running");
    expect((await dismiss(job.id)).status).toBe(409);
  });

  it("never touches another owner's job", async () => {
    const other = await createUser({ email: "toinen@example.com" });
    const job = await failedJob(other.id);
    expect((await dismiss(job.id)).status).toBe(409);
    expect((await prisma.backgroundJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("failed");
  });
});

describe("bank health counts a connection only while its newest sync failed (2026-10-09)", () => {
  async function connection(status = "active") {
    return prisma.bankConnection.create({
      data: { userId: user.id, aspspName: "Holvi", aspspCountry: "FI", psuType: "business", status },
    });
  }
  function job(resourceId: string, status: string, minutesAgo: number) {
    const at = new Date(Date.now() - minutesAgo * 60_000);
    return prisma.backgroundJob.create({
      data: { userId: user.id, kind: "bank_sync", status, title: "Pankki", resourceId, createdAt: at, finishedAt: at, error: status === "failed" ? "Pankkiyhteys epäonnistui." : null },
    });
  }

  it("a later successful sync of the same connection clears it", async () => {
    const holvi = await connection();
    await job(holvi.id, "failed", 360);
    expect((await collectHealth()).checks.bankJobs.ok).toBe(false);
    await job(holvi.id, "done", 10);
    expect((await collectHealth()).checks.bankJobs).toMatchObject({ ok: true, failedRecent: 0 });
  });

  it("a revoked connection's failures do not count; a connection still failing does", async () => {
    const old = await connection("revoked");
    await job(old.id, "failed", 30);
    expect((await collectHealth()).checks.bankJobs.ok).toBe(true);
    const failing = await connection();
    await job(failing.id, "done", 120);
    await job(failing.id, "failed", 5);
    expect((await collectHealth()).checks.bankJobs).toMatchObject({ ok: false, failedRecent: 1 });
  });
});
