import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import { GET as me } from "@/app/api/auth/me/route";
import { POST as forgotPassword } from "@/app/api/auth/password/forgot/route";
import { GET as listRequests, POST as accountRequest } from "@/app/api/account/request/route";
import { GET as downloadPackage } from "@/app/api/account/request/[id]/package/route";
import { GET as listConversations } from "@/app/api/ai/conversations/route";
import { prisma } from "@/lib/db";
import {
  completeAccountClose,
  completeAccountExport,
  setAccountRequestStatus,
} from "@/lib/account-requests";
import { CLOSED_LOGIN_MESSAGE } from "@/lib/account-copy";
import { resetRateLimitsForTests } from "@/lib/rate-limit";
import { createReceipt, createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext } from "./helpers/http";

const PASSWORD = "salasana1234";
const MAIL_KEYS = [
  "PLATFORM_SMTP_HOST",
  "PLATFORM_SMTP_FROM",
  "PLATFORM_SMTP_PORT",
  "PLATFORM_SMTP_USER",
  "PLATFORM_SMTP_PASS",
  "MAIL_TRANSPORT",
] as const;

let user: TestUser;

function cookieOf(response: Response): string {
  const parts =
    typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie") || ""];
  const match = parts.join(";").match(/lashkirja-session=[^;]+/);
  if (!match) throw new Error(`session cookie missing: ${parts.join(" | ")}`);
  return match[0];
}

function snapshotMailEnv(): Record<(typeof MAIL_KEYS)[number], string | undefined> {
  return Object.fromEntries(MAIL_KEYS.map((key) => [key, process.env[key]])) as Record<
    (typeof MAIL_KEYS)[number],
    string | undefined
  >;
}

function restoreMailEnv(saved: Record<(typeof MAIL_KEYS)[number], string | undefined>) {
  for (const key of MAIL_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

async function loginAs(email: string) {
  const response = await login(
    buildRequest(
      "POST",
      "/api/auth/login",
      { email, password: PASSWORD },
      { headers: { "user-agent": "Mozilla/5.0 (Linux) Firefox/120" } }
    )
  );
  expect(response.status).toBe(200);
  return cookieOf(response);
}

beforeEach(async () => {
  resetRateLimitsForTests();
  await resetDatabase();
  user = await createUser();
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(PASSWORD, 4) },
  });
});

describe("account request workflow", () => {
  it("shows status, keeps the books, and disables login when a close is completed", async () => {
    const cookie = await loginAs(user.email);
    const denied = await accountRequest(
      buildRequest("POST", "/api/account/request", { kind: "close", currentPassword: "vaara" }, { cookie })
    );
    expect(denied.status).toBe(401);

    const accepted = await accountRequest(
      buildRequest("POST", "/api/account/request", { kind: "close", currentPassword: PASSWORD }, { cookie })
    );
    expect(accepted.status).toBe(200);
    const created = await readJson<{ request: { id: string; status: string } }>(accepted);
    expect(created.request.status).toBe("pending");

    const listed = await readJson<{
      requests: Array<{ id: string; status: string; statusLabel: string; downloadable: boolean }>;
    }>(await listRequests(buildRequest("GET", "/api/account/request", undefined, { cookie })));
    expect(listed.requests[0]).toMatchObject({
      id: created.request.id,
      status: "pending",
      statusLabel: "Odottaa",
      downloadable: false,
    });

    await setAccountRequestStatus(created.request.id, "in_progress");
    const working = await readJson<{ requests: Array<{ status: string; statusLabel: string }> }>(
      await listRequests(buildRequest("GET", "/api/account/request", undefined, { cookie }))
    );
    expect(working.requests[0]).toMatchObject({ status: "in_progress", statusLabel: "Käsittelyssä" });

    await createReceipt(user.id);
    await completeAccountClose(created.request.id);

    expect(await prisma.receipt.count({ where: { userId: user.id } })).toBe(1);
    const closed = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(closed.accessDisabledAt).not.toBeNull();
    expect((await me(buildRequest("GET", "/api/auth/me", undefined, { cookie }))).status).toBe(401);

    const again = await login(
      buildRequest("POST", "/api/auth/login", { email: user.email, password: PASSWORD })
    );
    expect(again.status).toBe(403);
    expect((await readJson<{ error: string }>(again)).error).toBe(CLOSED_LOGIN_MESSAGE);
    expect(CLOSED_LOGIN_MESSAGE).toMatch(/^Tilin käyttö on suljettu\./);
  });

  it("lets the owner download a completed export and hides it from another user", async () => {
    const cookie = await loginAs(user.email);
    const accepted = await accountRequest(
      buildRequest("POST", "/api/account/request", { kind: "export", currentPassword: PASSWORD }, { cookie })
    );
    expect(accepted.status).toBe(200);
    const created = await readJson<{ request: { id: string } }>(accepted);
    await completeAccountExport(created.request.id);

    const listed = await readJson<{ requests: Array<{ downloadable: boolean; statusLabel: string }> }>(
      await listRequests(buildRequest("GET", "/api/account/request", undefined, { cookie }))
    );
    expect(listed.requests[0]).toMatchObject({ downloadable: true, statusLabel: "Valmis" });

    const file = await downloadPackage(
      buildRequest("GET", `/api/account/request/${created.request.id}/package`, undefined, { cookie }),
      routeContext({ id: created.request.id })
    );
    expect(file.status).toBe(200);
    expect(file.headers.get("content-type")).toContain("application/zip");
    const bytes = Buffer.from(await file.arrayBuffer());
    expect(bytes.subarray(0, 2).toString("utf8")).toBe("PK");

    const other = await createUser({ email: `muu-${user.id}@example.com` });
    await prisma.user.update({
      where: { id: other.id },
      data: { passwordHash: await bcrypt.hash(PASSWORD, 4) },
    });
    const otherCookie = await loginAs(other.email);
    const hidden = await downloadPackage(
      buildRequest("GET", `/api/account/request/${created.request.id}/package`, undefined, { cookie: otherCookie }),
      routeContext({ id: created.request.id })
    );
    expect(hidden.status).toBe(404);
  });
});

describe("password recovery without invoice SMTP", () => {
  it("queues a visible recovery request when no mail path exists", async () => {
    const saved = snapshotMailEnv();
    try {
      for (const key of MAIL_KEYS) delete process.env[key];
      const sent = await forgotPassword(
        buildRequest("POST", "/api/auth/password/forgot", { email: user.email })
      );
      expect(sent.status).toBe(200);
      expect((await readJson<{ message: string }>(sent)).message).toMatch(/tukeen/);
      expect(await prisma.accountToken.count({ where: { userId: user.id } })).toBe(1);
      const queued = await prisma.accountRequest.findMany({
        where: { userId: user.id, kind: "recovery" },
      });
      expect(queued).toHaveLength(1);
      expect(queued[0]?.status).toBe("pending");

      await forgotPassword(buildRequest("POST", "/api/auth/password/forgot", { email: user.email }));
      expect(await prisma.accountRequest.count({ where: { userId: user.id, kind: "recovery" } })).toBe(1);

      const cookie = await loginAs(user.email);
      const listed = await readJson<{ requests: Array<{ kind: string; kindLabel: string; status: string }> }>(
        await listRequests(buildRequest("GET", "/api/account/request", undefined, { cookie }))
      );
      expect(listed.requests[0]).toMatchObject({
        kind: "recovery",
        kindLabel: "Salasanan palautus",
        status: "pending",
      });
    } finally {
      restoreMailEnv(saved);
    }
  });

  it("sends through platform SMTP and does not queue a recovery row", async () => {
    const saved = snapshotMailEnv();
    try {
      process.env.PLATFORM_SMTP_HOST = "mail.example.test";
      process.env.PLATFORM_SMTP_FROM = "LashKirja <noreply@example.test>";
      process.env.MAIL_TRANSPORT = "json";
      delete process.env.PLATFORM_SMTP_USER;
      delete process.env.PLATFORM_SMTP_PASS;
      const sent = await forgotPassword(
        buildRequest("POST", "/api/auth/password/forgot", { email: user.email })
      );
      expect(sent.status).toBe(200);
      expect(await prisma.accountToken.count({ where: { userId: user.id } })).toBe(1);
      expect(await prisma.accountRequest.count({ where: { userId: user.id, kind: "recovery" } })).toBe(0);
    } finally {
      restoreMailEnv(saved);
    }
  });
});

describe("conversation list past the first page", () => {
  it("returns the next page with a cursor and rejects a half cursor", async () => {
    const cookie = await loginAs(user.email);
    const start = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 51; i += 1) {
      await prisma.conversation.create({
        data: {
          userId: user.id,
          title: `Vanha ${String(i).padStart(2, "0")}`,
          updatedAt: new Date(start + i * 60_000),
          // Listed only once used: an empty conversation is left out.
          messages: { create: { userId: user.id, role: "user", content: "kysymys" } },
        },
      });
    }

    const first = await readJson<{
      conversations: Array<{ id: string; title: string; updatedAt: string }>;
      hasMore: boolean;
    }>(await listConversations(buildRequest("GET", "/api/ai/conversations", undefined, { cookie })));
    expect(first.conversations).toHaveLength(50);
    expect(first.hasMore).toBe(true);
    expect(first.conversations.map((row) => row.title)).not.toContain("Vanha 00");

    const cursor = first.conversations[first.conversations.length - 1];
    const params = new URLSearchParams({
      before: new Date(cursor.updatedAt).toISOString(),
      beforeId: cursor.id,
    });
    const second = await readJson<{
      conversations: Array<{ title: string }>;
      hasMore: boolean;
    }>(
      await listConversations(
        buildRequest("GET", `/api/ai/conversations?${params.toString()}`, undefined, { cookie })
      )
    );
    expect(second.hasMore).toBe(false);
    expect(second.conversations.map((row) => row.title)).toEqual(["Vanha 00"]);

    const half = await listConversations(
      buildRequest("GET", "/api/ai/conversations?beforeId=abc", undefined, { cookie })
    );
    expect(half.status).toBe(400);
  });

  it("leaves out a conversation that was opened but never used", async () => {
    const cookie = await loginAs(user.email);
    const empty = await prisma.conversation.create({ data: { userId: user.id, title: "Tyhjä keskustelu" } });
    const list = await readJson<{ conversations: Array<{ id: string }> }>(
      await listConversations(buildRequest("GET", "/api/ai/conversations", undefined, { cookie }))
    );
    expect(list.conversations.map((row) => row.id)).not.toContain(empty.id);
  });
});
