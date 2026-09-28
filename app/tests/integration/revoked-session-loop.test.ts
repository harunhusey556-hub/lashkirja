import { sealData } from "iron-session";
import { beforeEach, describe, expect, it } from "vitest";
import { proxy } from "@/proxy";
import { prisma } from "@/lib/db";
import { openAuthSession } from "@/lib/account-security";
import { sessionOptions, type SessionData } from "@/lib/session";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest } from "./helpers/http";

/**
 * Reproduces research §3 / H3: a cookie whose AuthSession row (or, for a
 * legacy cookie with no sessionId, the user's legacySessionsRevokedAt) has
 * been revoked still unseals cleanly. Before the fix, proxy() only checks
 * the seal, so it treats the cookie as authenticated: GET /login bounces to
 * /dashboard, and nothing ever clears the cookie, so the next /login hit
 * loops forever. After the fix, /login and / do a DB-backed revocation
 * check and clear the cookie, so the loop cannot start.
 */

let user: TestUser;

async function seal(data: SessionData): Promise<string> {
  const sealed = await sealData(data, {
    password: sessionOptions.password as string,
    ttl: sessionOptions.ttl,
  });
  return `${sessionOptions.cookieName}=${sealed}`;
}

function isRedirectTo(response: Response, path: string): boolean {
  const location = response.headers.get("location");
  return response.status === 307 && !!location && new URL(location).pathname === path;
}

function isPassThrough(response: Response): boolean {
  return response.headers.get("location") === null && response.headers.get("x-middleware-next") === "1";
}

function cookieWasCleared(response: Response): boolean {
  const setCookie = response.headers.get("set-cookie") ?? "";
  return setCookie.includes(`${sessionOptions.cookieName}=`) && /max-age=0/i.test(setCookie);
}

beforeEach(async () => {
  await resetDatabase();
  user = await createUser();
});

describe("revoked-session redirect loop", () => {
  it("sanity: an active tracked session still bounces /login to /dashboard", async () => {
    const row = await openAuthSession(user.id, "TestAgent");
    const cookie = await seal({ userId: user.id, email: user.email, firstName: "Testi", sessionId: row.id });

    const response = await proxy(buildRequest("GET", "/login", undefined, { cookie }));
    expect(isRedirectTo(response, "/dashboard")).toBe(true);
  });

  it("lets /login render (no bounce to /dashboard) once the session row is revoked, and clears the cookie", async () => {
    const row = await openAuthSession(user.id, "TestAgent");
    const cookie = await seal({ userId: user.id, email: user.email, firstName: "Testi", sessionId: row.id });
    await prisma.authSession.update({ where: { id: row.id }, data: { revokedAt: new Date() } });

    const loginResponse = await proxy(buildRequest("GET", "/login", undefined, { cookie }));
    expect(isPassThrough(loginResponse)).toBe(true);
    expect(cookieWasCleared(loginResponse)).toBe(true);

    // The loop is now broken for good: a follow-up hit with the (now
    // cleared) cookie removed behaves like any other signed-out visit.
    const again = await proxy(buildRequest("GET", "/login", undefined, {}));
    expect(isPassThrough(again)).toBe(true);
  });

  it("sends a revoked cookie on / to /login instead of /dashboard, and clears the cookie", async () => {
    const row = await openAuthSession(user.id, "TestAgent");
    const cookie = await seal({ userId: user.id, email: user.email, firstName: "Testi", sessionId: row.id });
    await prisma.authSession.update({ where: { id: row.id }, data: { revokedAt: new Date() } });

    const response = await proxy(buildRequest("GET", "/", undefined, { cookie }));
    expect(isRedirectTo(response, "/login")).toBe(true);
    expect(cookieWasCleared(response)).toBe(true);
  });

  it("also breaks the loop for a legacy cookie (no sessionId) after logout-all revokes every legacy session", async () => {
    const legacyCookie = await seal({ userId: user.id, email: user.email, firstName: "Testi" });

    const beforeRevoke = await proxy(buildRequest("GET", "/login", undefined, { cookie: legacyCookie }));
    expect(isRedirectTo(beforeRevoke, "/dashboard")).toBe(true);

    await prisma.user.update({ where: { id: user.id }, data: { legacySessionsRevokedAt: new Date() } });

    const afterRevoke = await proxy(buildRequest("GET", "/login", undefined, { cookie: legacyCookie }));
    expect(isPassThrough(afterRevoke)).toBe(true);
    expect(cookieWasCleared(afterRevoke)).toBe(true);
  });

  it("still gates /login cheaply (no DB call needed) for a signed-out visitor with no cookie", async () => {
    const response = await proxy(buildRequest("GET", "/login", undefined, {}));
    expect(isPassThrough(response)).toBe(true);
  });
});
