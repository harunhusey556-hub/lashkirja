import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST as registerOptions } from "@/app/api/auth/passkey/register/options/route";
import { POST as registerVerify } from "@/app/api/auth/passkey/register/verify/route";
import { POST as authOptions } from "@/app/api/auth/passkey/authenticate/options/route";
import { POST as authVerify } from "@/app/api/auth/passkey/authenticate/verify/route";
import { GET as listRoute } from "@/app/api/auth/passkey/route";
import { DELETE as deleteRoute, PATCH as renameRoute } from "@/app/api/auth/passkey/[id]/route";
import { GET as statusRoute } from "@/app/api/auth/passkey/status/route";
import { GET as aasaRoute } from "@/app/.well-known/apple-app-site-association/route";
import { GET as me } from "@/app/api/auth/me/route";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { config as proxyConfig } from "@/proxy";
import { prisma } from "@/lib/db";
import { resetRateLimitsForTests } from "@/lib/rate-limit";
import { PASSKEY_CHALLENGE_TTL_MS, PASSKEY_SIGNIN_FAILED } from "@/lib/passkey";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson, routeContext, sessionCookie } from "./helpers/http";
import { SoftAuthenticator } from "./helpers/soft-authenticator";

const RP_ID = "lashkirja.test";
const ORIGIN = `https://${RP_ID}`;

let user: TestUser;
let cookie: string;

beforeEach(async () => {
  process.env.WEBAUTHN_RP_ID = RP_ID;
  delete process.env.WEBAUTHN_ORIGINS;
  delete process.env.APPLE_TEAM_ID;
  resetRateLimitsForTests();
  await prisma.passkeyChallenge.deleteMany();
  await resetDatabase();
  user = await createUser();
  cookie = await sessionCookie(user);
});

afterEach(() => {
  delete process.env.WEBAUTHN_RP_ID;
  delete process.env.APPLE_TEAM_ID;
});

async function registerPasskey(authenticator: SoftAuthenticator, asCookie = cookie, deviceName?: string) {
  const optionsRes = await registerOptions(buildRequest("POST", "/api/auth/passkey/register/options", {}, { cookie: asCookie }));
  expect(optionsRes.status).toBe(200);
  const { challengeId, options } = await readJson(optionsRes);
  const response = authenticator.register(options);
  return registerVerify(
    buildRequest("POST", "/api/auth/passkey/register/verify", { challengeId, response, deviceName }, { cookie: asCookie })
  );
}

async function startSignIn() {
  const res = await authOptions(buildRequest("POST", "/api/auth/passkey/authenticate/options", {}));
  expect(res.status).toBe(200);
  return readJson<{ challengeId: string; options: { challenge: string; rpId: string; allowCredentials?: unknown } }>(res);
}

function verify(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return authVerify(buildRequest("POST", "/api/auth/passkey/authenticate/verify", body, { headers }));
}

describe("configuration", () => {
  it("is off without WEBAUTHN_RP_ID: status says so and options refuse with 503", async () => {
    delete process.env.WEBAUTHN_RP_ID;
    expect(await readJson(await statusRoute())).toEqual({ web: false, native: false });
    const res = await authOptions(buildRequest("POST", "/api/auth/passkey/authenticate/options", {}));
    expect(res.status).toBe(503);
  });

  it("native needs APPLE_TEAM_ID as well", async () => {
    expect(await readJson(await statusRoute())).toEqual({ web: true, native: false });
    process.env.APPLE_TEAM_ID = "ABCDE12345";
    expect(await readJson(await statusRoute())).toEqual({ web: true, native: true });
  });

  it("serves apple-app-site-association as JSON with the team-prefixed bundle id, and 404 without a team id", async () => {
    expect((await aasaRoute()).status).toBe(404);
    process.env.APPLE_TEAM_ID = "ABCDE12345";
    const res = await aasaRoute();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await readJson(res)).toEqual({ webcredentials: { apps: ["ABCDE12345.fi.tiyouba.lashkirja"] } });
  });

  it("the proxy never runs on the AASA path (no redirect to /login), but still guards other pages", () => {
    const url = "http://localhost:3000/.well-known/apple-app-site-association";
    expect(unstable_doesMiddlewareMatch({ config: proxyConfig, url })).toBe(false);
    expect(unstable_doesMiddlewareMatch({ config: proxyConfig, url: "http://localhost:3000/dashboard" })).toBe(true);
  });
});

describe("registration", () => {
  it("requires a signed-in session", async () => {
    const res = await registerOptions(buildRequest("POST", "/api/auth/passkey/register/options", {}));
    expect(res.status).toBe(401);
  });

  it("stores the credential with its name, then lists it", async () => {
    const authenticator = new SoftAuthenticator(RP_ID, ORIGIN);
    const res = await registerPasskey(authenticator, cookie, "Oma iPhone");
    expect(res.status).toBe(201);
    const row = await prisma.passkeyCredential.findUnique({ where: { id: authenticator.id } });
    expect(row).toMatchObject({ userId: user.id, deviceName: "Oma iPhone", counter: BigInt(0) });
    expect(JSON.parse(row!.transports!)).toEqual(["internal", "hybrid"]);

    const list = await readJson(await listRoute(buildRequest("GET", "/api/auth/passkey", undefined, { cookie })));
    expect(list.passkeys).toHaveLength(1);
    expect(list.passkeys[0]).toMatchObject({ id: authenticator.id, deviceName: "Oma iPhone", lastUsedAt: null });
    expect(list.passkeys[0].publicKey).toBeUndefined();
  });

  it("excludes already registered credentials in later options", async () => {
    const authenticator = new SoftAuthenticator(RP_ID, ORIGIN);
    await registerPasskey(authenticator);
    const res = await registerOptions(buildRequest("POST", "/api/auth/passkey/register/options", {}, { cookie }));
    const { options } = await readJson(res);
    expect(options.excludeCredentials.map((c: { id: string }) => c.id)).toEqual([authenticator.id]);
    expect(options.authenticatorSelection).toMatchObject({ residentKey: "required", userVerification: "required" });
  });

  it("rejects a response from the wrong origin", async () => {
    const authenticator = new SoftAuthenticator(RP_ID, "https://evil.example");
    const res = await registerPasskey(authenticator);
    expect(res.status).toBe(400);
    expect(await prisma.passkeyCredential.count()).toBe(0);
  });

  it("rejects another user's registration challenge", async () => {
    const other = await createUser({ email: "toinen@example.com" });
    const optionsRes = await registerOptions(buildRequest("POST", "/api/auth/passkey/register/options", {}, { cookie }));
    const { challengeId, options } = await readJson(optionsRes);
    const response = new SoftAuthenticator(RP_ID, ORIGIN).register(options);
    const res = await registerVerify(
      buildRequest(
        "POST",
        "/api/auth/passkey/register/verify",
        { challengeId, response },
        { cookie: await sessionCookie(other) }
      )
    );
    expect(res.status).toBe(400);
  });
});

describe("usernameless sign-in", () => {
  it("options name no account and list no credential ids", async () => {
    await registerPasskey(new SoftAuthenticator(RP_ID, ORIGIN));
    const { options } = await startSignIn();
    expect(options.rpId).toBe(RP_ID);
    expect(options.allowCredentials).toBeUndefined();
    expect(JSON.stringify(options)).not.toContain(user.email);
    expect(JSON.stringify(options)).not.toContain(user.id);
  });

  it("registration -> authentication -> the same bearer session the password login issues", async () => {
    const authenticator = new SoftAuthenticator(RP_ID, ORIGIN);
    await registerPasskey(authenticator);
    const { challengeId, options } = await startSignIn();
    const res = await verify({
      challengeId,
      response: authenticator.authenticate(options),
      transport: "bearer",
      device: "ios-app",
    });
    expect(res.status).toBe(200);
    expect(res.headers.getSetCookie()).toHaveLength(0);
    const body = await readJson(res);
    expect(body.tokenType).toBe("Bearer");
    expect(body.user).toEqual({ userId: user.id, email: user.email, firstName: "Testi" });

    const meRes = await me(buildRequest("GET", "/api/auth/me", undefined, { headers: { authorization: `Bearer ${body.token}` } }));
    expect(meRes.status).toBe(200);
    const session = await prisma.authSession.findFirst({ where: { userId: user.id } });
    expect(session?.label).toBe("iPhone · LashKirja-sovellus");
    const row = await prisma.passkeyCredential.findUnique({ where: { id: authenticator.id } });
    expect(row?.lastUsedAt).not.toBeNull();
  });

  it("cookie transport sets the web session cookie", async () => {
    const authenticator = new SoftAuthenticator(RP_ID, ORIGIN);
    await registerPasskey(authenticator);
    const { challengeId, options } = await startSignIn();
    const res = await verify({ challengeId, response: authenticator.authenticate(options), transport: "cookie" });
    expect(res.status).toBe(200);
    const setCookie = res.headers.getSetCookie().join(";");
    expect(setCookie).toContain("=");
    const sessionCookieValue = res.headers.getSetCookie()[0].split(";")[0];
    const meRes = await me(buildRequest("GET", "/api/auth/me", undefined, { cookie: sessionCookieValue }));
    expect(meRes.status).toBe(200);
  });

  it("cookie transport is refused for the bundled app's origin", async () => {
    const authenticator = new SoftAuthenticator(RP_ID, ORIGIN);
    await registerPasskey(authenticator);
    const { challengeId, options } = await startSignIn();
    const res = await verify(
      { challengeId, response: authenticator.authenticate(options), transport: "cookie" },
      { origin: "capacitor://localhost" }
    );
    expect(res.status).toBe(400);
  });

  it("a replayed challenge is rejected, even with a freshly signed response", async () => {
    const authenticator = new SoftAuthenticator(RP_ID, ORIGIN);
    await registerPasskey(authenticator);
    const { challengeId, options } = await startSignIn();
    expect((await verify({ challengeId, response: authenticator.authenticate(options), transport: "bearer" })).status).toBe(200);
    const replay = await verify({ challengeId, response: authenticator.authenticate(options), transport: "bearer" });
    expect(replay.status).toBe(401);
    expect(await readJson(replay)).toEqual({ error: PASSKEY_SIGNIN_FAILED });
  });

  it("a failed attempt still burns the challenge", async () => {
    const authenticator = new SoftAuthenticator(RP_ID, ORIGIN);
    await registerPasskey(authenticator);
    const { challengeId, options } = await startSignIn();
    const wrongOrigin = authenticator.authenticate(options, { origin: "https://evil.example" });
    expect((await verify({ challengeId, response: wrongOrigin, transport: "bearer" })).status).toBe(401);
    expect((await verify({ challengeId, response: authenticator.authenticate(options), transport: "bearer" })).status).toBe(401);
  });

  it("an expired challenge is rejected", async () => {
    const authenticator = new SoftAuthenticator(RP_ID, ORIGIN);
    await registerPasskey(authenticator);
    const { challengeId, options } = await startSignIn();
    await prisma.passkeyChallenge.update({
      where: { id: challengeId },
      data: { expiresAt: new Date(Date.now() - PASSKEY_CHALLENGE_TTL_MS) },
    });
    expect((await verify({ challengeId, response: authenticator.authenticate(options), transport: "bearer" })).status).toBe(401);
  });

  it("a registration challenge cannot be used to sign in", async () => {
    const authenticator = new SoftAuthenticator(RP_ID, ORIGIN);
    await registerPasskey(authenticator);
    const optionsRes = await registerOptions(buildRequest("POST", "/api/auth/passkey/register/options", {}, { cookie }));
    const { challengeId, options } = await readJson(optionsRes);
    const res = await verify({ challengeId, response: authenticator.authenticate(options), transport: "bearer" });
    expect(res.status).toBe(401);
  });

  it("a deleted credential is rejected, with the same message as an unknown one", async () => {
    const authenticator = new SoftAuthenticator(RP_ID, ORIGIN);
    await registerPasskey(authenticator);
    const del = await deleteRoute(
      buildRequest("DELETE", `/api/auth/passkey/${authenticator.id}`, undefined, { cookie }),
      routeContext({ id: authenticator.id })
    );
    expect(del.status).toBe(200);
    const { challengeId, options } = await startSignIn();
    const res = await verify({ challengeId, response: authenticator.authenticate(options), transport: "bearer" });
    expect(res.status).toBe(401);
    expect(await readJson(res)).toEqual({ error: PASSKEY_SIGNIN_FAILED });

    const stranger = new SoftAuthenticator(RP_ID, ORIGIN);
    stranger.userHandle = "eA";
    const second = await startSignIn();
    const unknown = await verify({ challengeId: second.challengeId, response: stranger.authenticate(second.options), transport: "bearer" });
    expect(await readJson(unknown)).toEqual({ error: PASSKEY_SIGNIN_FAILED });
  });

  it("a user handle naming a different account is rejected", async () => {
    const authenticator = new SoftAuthenticator(RP_ID, ORIGIN);
    await registerPasskey(authenticator);
    const { challengeId, options } = await startSignIn();
    const res = await verify({
      challengeId,
      response: authenticator.authenticate(options, { userHandle: Buffer.from("someone-else").toString("base64url") }),
      transport: "bearer",
    });
    expect(res.status).toBe(401);
  });

  it("counter: stored on success; a response whose counter does not advance is rejected", async () => {
    const authenticator = new SoftAuthenticator(RP_ID, ORIGIN, { counter: 0, counterStep: 1 });
    await registerPasskey(authenticator);
    const first = await startSignIn();
    expect((await verify({ challengeId: first.challengeId, response: authenticator.authenticate(first.options), transport: "bearer" })).status).toBe(200);
    expect((await prisma.passkeyCredential.findUnique({ where: { id: authenticator.id } }))?.counter).toBe(BigInt(1));

    // A clone replaying the same counter value.
    authenticator.counter = 0;
    const second = await startSignIn();
    const res = await verify({ challengeId: second.challengeId, response: authenticator.authenticate(second.options), transport: "bearer" });
    expect(res.status).toBe(401);
    expect((await prisma.passkeyCredential.findUnique({ where: { id: authenticator.id } }))?.counter).toBe(BigInt(1));
  });

  it("an always-zero counter (Apple passkeys) keeps working", async () => {
    const authenticator = new SoftAuthenticator(RP_ID, ORIGIN);
    await registerPasskey(authenticator);
    for (let i = 0; i < 2; i += 1) {
      const { challengeId, options } = await startSignIn();
      expect((await verify({ challengeId, response: authenticator.authenticate(options), transport: "bearer" })).status).toBe(200);
    }
  });

  it("a closed account gets 403 with the closed-account message", async () => {
    const authenticator = new SoftAuthenticator(RP_ID, ORIGIN);
    await registerPasskey(authenticator);
    await prisma.user.update({ where: { id: user.id }, data: { accessDisabledAt: new Date() } });
    const { challengeId, options } = await startSignIn();
    expect((await verify({ challengeId, response: authenticator.authenticate(options), transport: "bearer" })).status).toBe(403);
  });

  it("shares the password login's per-IP rate limit", async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await verify({ challengeId: "x", response: {}, transport: "bearer" });
    }
    const res = await verify({ challengeId: "x", response: {}, transport: "bearer" });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});

describe("management", () => {
  it("renames and deletes only the caller's own passkeys", async () => {
    const authenticator = new SoftAuthenticator(RP_ID, ORIGIN);
    await registerPasskey(authenticator);
    const other = await createUser({ email: "toinen@example.com" });
    const otherCookie = await sessionCookie(other);

    const foreignRename = await renameRoute(
      buildRequest("PATCH", `/api/auth/passkey/${authenticator.id}`, { deviceName: "Hakkeri" }, { cookie: otherCookie }),
      routeContext({ id: authenticator.id })
    );
    expect(foreignRename.status).toBe(404);
    const foreignDelete = await deleteRoute(
      buildRequest("DELETE", `/api/auth/passkey/${authenticator.id}`, undefined, { cookie: otherCookie }),
      routeContext({ id: authenticator.id })
    );
    expect(foreignDelete.status).toBe(404);

    const rename = await renameRoute(
      buildRequest("PATCH", `/api/auth/passkey/${authenticator.id}`, { deviceName: "  Työpuhelin  " }, { cookie }),
      routeContext({ id: authenticator.id })
    );
    expect(rename.status).toBe(200);
    expect((await prisma.passkeyCredential.findUnique({ where: { id: authenticator.id } }))?.deviceName).toBe("Työpuhelin");

    const empty = await renameRoute(
      buildRequest("PATCH", `/api/auth/passkey/${authenticator.id}`, { deviceName: "   " }, { cookie }),
      routeContext({ id: authenticator.id })
    );
    expect(empty.status).toBe(400);
  });

  it("list requires a session", async () => {
    expect((await listRoute(buildRequest("GET", "/api/auth/passkey"))).status).toBe(401);
  });
});
