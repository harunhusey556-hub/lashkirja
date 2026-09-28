import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it } from "vitest";
import { POST as issueToken } from "@/app/api/auth/token/route";
import { POST as refreshToken, MAX_AUTH_SESSION_AGE_MS } from "@/app/api/auth/token/refresh/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as me } from "@/app/api/auth/me/route";
import { GET as sessionsGet, POST as sessionsPost } from "@/app/api/auth/sessions/route";
import { proxy } from "@/proxy";
import { prisma } from "@/lib/db";
import { resetRateLimitsForTests } from "@/lib/rate-limit";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, sessionCookie } from "./helpers/http";

function setCookiesOf(response: Response): string[] {
  return response.headers.getSetCookie
    ? response.headers.getSetCookie()
    : response.headers.get("set-cookie")
      ? [response.headers.get("set-cookie") as string]
      : [];
}

const PASSWORD = "salasana1234";
const WRONG_CREDENTIALS_MESSAGE =
  "Sähköposti tai salasana on väärin. Tarkista ja yritä uudelleen.";

let user: TestUser;

beforeEach(async () => {
  resetRateLimitsForTests();
  await resetDatabase();
  user = await createUser();
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(PASSWORD, 4) },
  });
});

async function issue(password = PASSWORD) {
  const response = await issueToken(
    buildRequest("POST", "/api/auth/token", { email: user.email, password })
  );
  return response;
}

describe("POST /api/auth/token", () => {
  it("issues a bearer token with no Set-Cookie", async () => {
    const response = await issue();
    expect(response.status).toBe(200);
    const body = await readJson<{ token: string; tokenType: string; expiresAt: string; user: unknown }>(
      response
    );
    expect(body.tokenType).toBe("Bearer");
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(20);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(body.user).toMatchObject({ userId: user.id, email: user.email, firstName: "Testi" });

    const setCookie =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : (response.headers.get("set-cookie") ? [response.headers.get("set-cookie") as string] : []);
    expect(setCookie).toHaveLength(0);
  });

  it("rejects a wrong password and an unknown email with byte-identical 401 bodies", async () => {
    const wrongPassword = await issue("not-the-password");
    const unknownEmail = await issueToken(
      buildRequest("POST", "/api/auth/token", { email: "nobody-here@example.com", password: PASSWORD })
    );
    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    const wrongBody = await readJson<{ error: string }>(wrongPassword);
    const unknownBody = await readJson<{ error: string }>(unknownEmail);
    expect(wrongBody).toEqual({ error: WRONG_CREDENTIALS_MESSAGE });
    expect(unknownBody).toEqual({ error: WRONG_CREDENTIALS_MESSAGE });
  });

  it("returns 429 with Retry-After on the 6th wrong attempt for one email", async () => {
    let last: Response | undefined;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      last = await issue("still-wrong");
    }
    expect(last?.status).toBe(429);
    const retryAfter = Number(last?.headers.get("Retry-After"));
    expect(Number.isFinite(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
  });

  it("returns 403 for a closed account", async () => {
    await prisma.user.update({ where: { id: user.id }, data: { accessDisabledAt: new Date() } });
    const response = await issue();
    expect(response.status).toBe(403);
  });
});

describe("bearer token authenticates protected routes", () => {
  it("GET /api/dashboard: 200 with the bearer, 401 without it", async () => {
    const { GET: dashboard } = await import("@/app/api/dashboard/route");
    const { token } = await readJson<{ token: string }>(await issue());

    const authenticated = await dashboard(
      buildRequest("GET", "/api/dashboard", undefined, { headers: { authorization: `Bearer ${token}` } })
    );
    expect(authenticated.status).toBe(200);

    const anonymous = await dashboard(buildRequest("GET", "/api/dashboard"));
    expect(anonymous.status).toBe(401);
  });

  it("also passes the proxy's own gate on a protected API path", async () => {
    const { token } = await readJson<{ token: string }>(await issue());
    const response = await proxy(
      buildRequest("GET", "/api/dashboard", undefined, { headers: { authorization: `Bearer ${token}` } })
    );
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});

describe("logout with a bearer token", () => {
  it("revokes the row; the same token then gets 401 from /api/auth/me and from a protected route behind the proxy gate", async () => {
    const { GET: dashboard } = await import("@/app/api/dashboard/route");
    const { token } = await readJson<{ token: string }>(await issue());
    const authHeader = { headers: { authorization: `Bearer ${token}` } };
    const logoutHeader = { headers: { authorization: `Bearer ${token}`, accept: "application/json" } };

    const logoutResponse = await logout(buildRequest("POST", "/api/auth/logout", undefined, logoutHeader));
    expect(logoutResponse.status).toBe(200);
    expect(
      logoutResponse.headers.getSetCookie ? logoutResponse.headers.getSetCookie() : []
    ).toHaveLength(0);

    const meResponse = await me(buildRequest("GET", "/api/auth/me", undefined, authHeader));
    expect(meResponse.status).toBe(401);

    // The proxy's own API gate is shallow (format-only, no DB — Task 1's
    // constraint), so a revoked-but-well-formed bearer still passes it; the
    // route handler's requireSession() is the authoritative, DB-backed
    // check. Confirmed here, in addition to the shallow-gate test below.
    const dashboardResponse = await dashboard(
      buildRequest("GET", "/api/dashboard", undefined, authHeader)
    );
    expect(dashboardResponse.status).toBe(401);
  });
});

describe("sessions scope=all also kills a bearer for the same user", () => {
  it("revokes every session, including one opened via the token endpoint", async () => {
    const cookie = await sessionCookie(user);
    const { token } = await readJson<{ token: string }>(await issue());

    const response = await sessionsPost(
      buildRequest("POST", "/api/auth/sessions", { scope: "all" }, { cookie })
    );
    expect(response.status).toBe(200);

    const meResponse = await me(
      buildRequest("GET", "/api/auth/me", undefined, { headers: { authorization: `Bearer ${token}` } })
    );
    expect(meResponse.status).toBe(401);
  });
});

describe("POST /api/auth/token/refresh", () => {
  it("returns a new token for the same AuthSession row with a later expiresAt", async () => {
    const first = await readJson<{ token: string; expiresAt: string }>(await issue());
    const firstRow = await prisma.authSession.findFirst({ where: { userId: user.id } });

    const refreshed = await refreshToken(
      buildRequest("POST", "/api/auth/token/refresh", undefined, {
        headers: { authorization: `Bearer ${first.token}` },
      })
    );
    expect(refreshed.status).toBe(200);
    const refreshedBody = await readJson<{ token: string; expiresAt: string }>(refreshed);
    expect(refreshedBody.token).not.toBe(first.token);

    const rows = await prisma.authSession.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(firstRow?.id);
  });

  it("returns 401 for a revoked token", async () => {
    const { token } = await readJson<{ token: string }>(await issue());
    await prisma.authSession.updateMany({ where: { userId: user.id }, data: { revokedAt: new Date() } });

    const response = await refreshToken(
      buildRequest("POST", "/api/auth/token/refresh", undefined, {
        headers: { authorization: `Bearer ${token}` },
      })
    );
    expect(response.status).toBe(401);
    expect(await readJson(response)).toEqual({
      error: { code: "UNAUTHORIZED", message: "Kirjautuminen vaaditaan" },
    });
  });

  it("returns 401 for a cookie-only request - refresh requires a bearer credential (final review I1)", async () => {
    const cookie = await sessionCookie(user);
    const response = await refreshToken(
      buildRequest("POST", "/api/auth/token/refresh", undefined, { cookie })
    );
    expect(response.status).toBe(401);
    expect(setCookiesOf(response)).toHaveLength(0);
  });

  it("returns 403 for a cross-site Origin, even with a valid bearer (final review I1)", async () => {
    const { token } = await readJson<{ token: string }>(await issue());
    const response = await refreshToken(
      buildRequest("POST", "/api/auth/token/refresh", undefined, {
        headers: { authorization: `Bearer ${token}` },
        origin: "https://evil.example",
        secFetchSite: "cross-site",
      })
    );
    expect(response.status).toBe(403);
  });

  it("still refreshes a bearer request that also carries a stale cookie, as long as Authorization is present", async () => {
    const cookie = await sessionCookie(user);
    const { token } = await readJson<{ token: string }>(await issue());
    const response = await refreshToken(
      buildRequest("POST", "/api/auth/token/refresh", undefined, {
        cookie,
        headers: { authorization: `Bearer ${token}` },
      })
    );
    expect(response.status).toBe(200);
  });

  it("returns 401 once the AuthSession row is older than the absolute age cap (final review I3)", async () => {
    const { token } = await readJson<{ token: string }>(await issue());
    await prisma.authSession.updateMany({
      where: { userId: user.id },
      data: { createdAt: new Date(Date.now() - (MAX_AUTH_SESSION_AGE_MS + 24 * 60 * 60 * 1000)) },
    });

    const response = await refreshToken(
      buildRequest("POST", "/api/auth/token/refresh", undefined, {
        headers: { authorization: `Bearer ${token}` },
      })
    );
    expect(response.status).toBe(401);
  });

  it("a token that was never refreshed keeps authenticating even past the absolute age cap - only refresh is bounded by it (final review I3)", async () => {
    const { token } = await readJson<{ token: string }>(await issue());
    await prisma.authSession.updateMany({
      where: { userId: user.id },
      data: { createdAt: new Date(Date.now() - (MAX_AUTH_SESSION_AGE_MS + 24 * 60 * 60 * 1000)) },
    });

    // The original token's own iron-sealed TTL (30 days) is untouched by the
    // row's age - only POST /api/auth/token/refresh enforces the cap.
    const meResponse = await me(
      buildRequest("GET", "/api/auth/me", undefined, { headers: { authorization: `Bearer ${token}` } })
    );
    expect(meResponse.status).toBe(200);

    const refreshResponse = await refreshToken(
      buildRequest("POST", "/api/auth/token/refresh", undefined, {
        headers: { authorization: `Bearer ${token}` },
      })
    );
    expect(refreshResponse.status).toBe(401);
  });

  it("returns 429 after 31 refreshes in an hour", async () => {
    const { token } = await readJson<{ token: string }>(await issue());
    let current = token;
    let last: Response | undefined;
    for (let attempt = 0; attempt < 31; attempt += 1) {
      last = await refreshToken(
        buildRequest("POST", "/api/auth/token/refresh", undefined, {
          headers: { authorization: `Bearer ${current}` },
        })
      );
      if (last.status === 200) {
        current = (await readJson<{ token: string }>(last)).token;
      }
    }
    expect(last?.status).toBe(429);
  });
});

describe("closeAccount-style accessDisabledAt kills a bearer", () => {
  it("401s a previously valid token once the account is disabled", async () => {
    const { token } = await readJson<{ token: string }>(await issue());
    await prisma.user.update({ where: { id: user.id }, data: { accessDisabledAt: new Date() } });

    const response = await me(
      buildRequest("GET", "/api/auth/me", undefined, { headers: { authorization: `Bearer ${token}` } })
    );
    expect(response.status).toBe(401);
  });
});

// Sanity: GET /api/auth/sessions still lists the current bearer session.
describe("GET /api/auth/sessions with a bearer", () => {
  it("lists the session the bearer names", async () => {
    const { token } = await readJson<{ token: string }>(await issue());
    const response = await sessionsGet(
      buildRequest("GET", "/api/auth/sessions", undefined, { headers: { authorization: `Bearer ${token}` } })
    );
    expect(response.status).toBe(200);
    const body = await readJson<{ sessions: Array<{ current: boolean }> }>(response);
    expect(body.sessions.some((s) => s.current)).toBe(true);
  });
});

describe("GET /api/auth/me 401 does not clear the cookie for a non-cookie caller (final review M7)", () => {
  it("a garbage bearer gets 401 with no Set-Cookie", async () => {
    const response = await me(
      buildRequest("GET", "/api/auth/me", undefined, { headers: { authorization: "Bearer not-a-real-token" } })
    );
    expect(response.status).toBe(401);
    expect(setCookiesOf(response)).toHaveLength(0);
  });

  it("an app-origin request with no credential gets 401 with no Set-Cookie", async () => {
    const response = await me(
      buildRequest("GET", "/api/auth/me", undefined, { origin: "capacitor://localhost" })
    );
    expect(response.status).toBe(401);
    expect(setCookiesOf(response)).toHaveLength(0);
  });

  it("a genuine web/cookie caller with a stale cookie still gets it cleared (unchanged behaviour)", async () => {
    const response = await me(
      buildRequest("GET", "/api/auth/me", undefined, { cookie: "lashkirja-session=garbage" })
    );
    expect(response.status).toBe(401);
    expect(setCookiesOf(response).length).toBeGreaterThan(0);
  });
});
