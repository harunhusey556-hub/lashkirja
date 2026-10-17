import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import bcrypt from "bcryptjs";
import { sealData, unsealData } from "iron-session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as issueToken } from "@/app/api/auth/token/route";
import { POST as refreshToken } from "@/app/api/auth/token/refresh/route";
import { GET as me } from "@/app/api/auth/me/route";
import { GET as sessionsGet } from "@/app/api/auth/sessions/route";
import { prisma } from "@/lib/db";
import { sealBearerToken } from "@/lib/auth-credential";
import { sessionOptions } from "@/lib/session-options";
import { resetRateLimitsForTests } from "@/lib/rate-limit";
import {
  ROTATION_GRACE_MS,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
  SESSION_TOUCH_MS,
} from "@/lib/session-limits";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildRequest, readJson } from "./helpers/http";

const PASSWORD = "salasana1234";

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

afterEach(() => {
  vi.restoreAllMocks();
});

interface Device {
  privateKey: KeyObject;
  /** Base64 of the 65-byte X9.63 point, as the app sends it. */
  publicKey: string;
}

function newDevice(): Device {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const point = Buffer.concat([
    Buffer.from([0x04]),
    Buffer.from(jwk.x as string, "base64url"),
    Buffer.from(jwk.y as string, "base64url"),
  ]);
  return { privateKey, publicKey: point.toString("base64") };
}

function signRefresh(device: Device, token: string, time = Math.floor(Date.now() / 1000)) {
  const hash = createHash("sha256").update(token).digest("hex");
  const signature = sign("sha256", Buffer.from(`lk-refresh-v1\n${time}\n${hash}`, "utf8"), {
    key: device.privateKey,
    dsaEncoding: "der",
  });
  return {
    "x-lk-device-time": String(time),
    "x-lk-device-signature": signature.toString("base64"),
  };
}

type TokenBody = { token: string };
type ErrorBody = { error: { code: string; message: string; reason: string } };

async function signIn(body: Record<string, unknown> = {}): Promise<string> {
  const response = await issueToken(
    buildRequest("POST", "/api/auth/token", { email: user.email, password: PASSWORD, ...body })
  );
  expect(response.status).toBe(200);
  return (await readJson<TokenBody>(response)).token;
}

function callMe(token: string) {
  return me(buildRequest("GET", "/api/auth/me", undefined, { headers: { authorization: `Bearer ${token}` } }));
}

function callRefresh(token: string, extra: Record<string, string> = {}) {
  return refreshToken(
    buildRequest("POST", "/api/auth/token/refresh", undefined, {
      headers: { authorization: `Bearer ${token}`, ...extra },
    })
  );
}

async function refreshOk(token: string, extra: Record<string, string> = {}): Promise<string> {
  const response = await callRefresh(token, extra);
  expect(response.status).toBe(200);
  return (await readJson<TokenBody>(response)).token;
}

async function reasonOf(response: Response): Promise<string> {
  expect(response.status).toBe(401);
  const body = await readJson<ErrorBody>(response);
  expect(body.error.code).toBe("UNAUTHORIZED");
  return body.error.reason;
}

const theRow = () => prisma.authSession.findFirstOrThrow({ where: { userId: user.id } });
const ago = (ms: number) => new Date(Date.now() - ms);

describe("idle and absolute expiry", () => {
  it("revokes a session idle for more than 30 days and answers reason idle", async () => {
    const token = await signIn();
    await prisma.authSession.updateMany({ data: { lastSeenAt: ago(SESSION_IDLE_MS + 60_000) } });

    expect(await reasonOf(await callMe(token))).toBe("idle");
    const row = await theRow();
    expect(row.revokedAt).not.toBeNull();
    expect(row.revokedReason).toBe("idle");
    // Dead for good: the next call is a plain revoked.
    expect(await reasonOf(await callMe(token))).toBe("revoked");
  });

  it("keeps a session that was used just inside the idle limit", async () => {
    const token = await signIn();
    await prisma.authSession.updateMany({ data: { lastSeenAt: ago(SESSION_IDLE_MS - 60_000) } });
    expect((await callMe(token)).status).toBe(200);
  });

  it("revokes a row older than 180 days even for a token that does not know its start (legacy)", async () => {
    const token = (
      await sealBearerToken({
        userId: user.id,
        email: user.email,
        firstName: "Testi",
        sessionId: (await prisma.authSession.create({ data: { userId: user.id, label: "vanha", createdAt: ago(SESSION_ABSOLUTE_MS + 60_000) } })).id,
      })
    ).token;

    expect(await reasonOf(await callMe(token))).toBe("absolute");
    expect((await theRow()).revokedReason).toBe("absolute");
  });

  it("refuses a token whose own sessionStartedAt is past 180 days without touching the database", async () => {
    const row = await prisma.authSession.create({ data: { userId: user.id, label: "x" } });
    const { token } = await sealBearerToken({
      userId: user.id,
      email: user.email,
      firstName: "Testi",
      sessionId: row.id,
      gen: 0,
      sessionStartedAt: Date.now() - SESSION_ABSOLUTE_MS - 60_000,
    });
    expect(await reasonOf(await callMe(token))).toBe("invalid");
  });

  it("applies idle and absolute to a cookie that names a session row as well", async () => {
    const row = await prisma.authSession.create({
      data: { userId: user.id, label: "web", lastSeenAt: ago(SESSION_IDLE_MS + 60_000) },
    });
    const sealed = await sealData(
      { userId: user.id, email: user.email, firstName: "Testi", sessionId: row.id },
      { password: sessionOptions.password as string, ttl: sessionOptions.ttl }
    );
    const response = await me(
      buildRequest("GET", "/api/auth/me", undefined, { cookie: `${sessionOptions.cookieName}=${sealed}` })
    );
    expect(await reasonOf(response)).toBe("idle");
    expect((await theRow()).revokedReason).toBe("idle");
  });
});

describe("lastSeenAt throttle", () => {
  it("is not written again within 10 minutes and is written after", async () => {
    const token = await signIn();
    const recent = ago(SESSION_TOUCH_MS - 60_000);
    await prisma.authSession.updateMany({ data: { lastSeenAt: recent } });
    expect((await callMe(token)).status).toBe(200);
    expect((await theRow()).lastSeenAt.getTime()).toBe(recent.getTime());

    const stale = ago(SESSION_TOUCH_MS + 60_000);
    await prisma.authSession.updateMany({ data: { lastSeenAt: stale } });
    expect((await callMe(token)).status).toBe(200);
    expect((await theRow()).lastSeenAt.getTime()).toBeGreaterThan(stale.getTime() + SESSION_TOUCH_MS);
  });
});

describe("token rotation", () => {
  it("issues generation + 1 without writing it, and commits it on first use", async () => {
    const first = await signIn();
    const second = await refreshOk(first);
    expect((await theRow()).tokenGeneration).toBe(0);

    // The old token is still fine until the new one is used.
    expect((await callMe(first)).status).toBe(200);
    expect((await theRow()).tokenGeneration).toBe(0);

    expect((await callMe(second)).status).toBe(200);
    const row = await theRow();
    expect(row.tokenGeneration).toBe(1);
    expect(row.rotatedAt).not.toBeNull();
  });

  it("keeps the session start through refreshes", async () => {
    const first = await signIn();
    const row = await theRow();
    const second = await refreshOk(first);
    await callMe(second);
    const third = await refreshOk(second);
    expect((await callMe(third)).status).toBe(200);
    expect((await theRow()).createdAt.getTime()).toBe(row.createdAt.getTime());
    expect((await theRow()).tokenGeneration).toBe(2);
  });

  it("accepts the previous generation inside the 2 minute grace", async () => {
    const first = await signIn();
    const second = await refreshOk(first);
    await callMe(second);
    expect((await callMe(first)).status).toBe(200);
  });

  it("revokes the session when a plain request carries the previous generation after the grace (reuse)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = await signIn();
    const second = await refreshOk(first);
    await callMe(second);
    await prisma.authSession.updateMany({ data: { rotatedAt: ago(ROTATION_GRACE_MS + 5_000) } });
    expect(await reasonOf(await callMe(first))).toBe("reuse");
    const row = await theRow();
    expect(row.revokedAt).not.toBeNull();
    expect(row.revokedReason).toBe("reuse");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[auth] refresh token reuse"));
    expect(warn.mock.calls.flat().join(" ")).not.toContain(first);
    expect(await reasonOf(await callMe(second))).toBe("revoked");
  });

  it("does not let a copy that refreshed first keep an unbound session once the owner's token comes back", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const owners = await signIn();
    expect((await theRow()).deviceKey).toBeNull();
    // The copy refreshes before the owner does and starts using its token.
    const copys = await refreshOk(owners);
    expect((await callMe(copys)).status).toBe(200);
    await prisma.authSession.updateMany({ data: { rotatedAt: ago(ROTATION_GRACE_MS + 5_000) } });

    // The owner's next load (not a refresh) ends the family, the copy's token with it.
    expect(await reasonOf(await callMe(owners))).toBe("reuse");
    expect(await reasonOf(await callMe(copys))).toBe("revoked");
    expect(await reasonOf(await callRefresh(copys))).toBe("revoked");
  });

  it("refuses a generation more than one ahead as invalid", async () => {
    await signIn();
    const row = await theRow();
    const { token } = await sealBearerToken({
      userId: user.id,
      email: user.email,
      firstName: "Testi",
      sessionId: row.id,
      gen: row.tokenGeneration + 2,
      sessionStartedAt: row.createdAt.getTime(),
    });
    expect(await reasonOf(await callMe(token))).toBe("invalid");
  });

  it("refreshing a token commits it, so the next refresh can chain on", async () => {
    const first = await signIn();
    const second = await refreshOk(first);
    const third = await refreshOk(second);
    expect((await theRow()).tokenGeneration).toBe(1);
    expect((await callMe(third)).status).toBe(200);
    expect((await theRow()).tokenGeneration).toBe(2);
  });

  it("revokes the session when a replaced token is refreshed after the grace (reuse)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = await signIn();
    const second = await refreshOk(first);
    await callMe(second);
    await prisma.authSession.updateMany({ data: { rotatedAt: ago(ROTATION_GRACE_MS + 5_000) } });

    expect(await reasonOf(await callRefresh(first))).toBe("reuse");
    const row = await theRow();
    expect(row.revokedAt).not.toBeNull();
    expect(row.revokedReason).toBe("reuse");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[auth] refresh token reuse"));
    expect(warn.mock.calls.flat().join(" ")).not.toContain(first);
    // The family is dead, newest token included.
    expect(await reasonOf(await callMe(second))).toBe("revoked");
  });

  it("answers a sibling refresh of the previous generation inside the grace with the committed token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = await signIn();
    // Two refreshes with the same token; the first answer is used before the second lands.
    const second = await refreshOk(first);
    await callMe(second);
    const late = await refreshOk(first);

    const row = await theRow();
    expect(row.revokedAt).toBeNull();
    expect(row.tokenGeneration).toBe(1);
    expect((await callMe(late)).status).toBe(200);
    expect((await callMe(second)).status).toBe(200);
    expect((await theRow()).tokenGeneration).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    // Both answers are the same generation: the next refresh chains on from either.
    expect((await callMe(await refreshOk(late))).status).toBe(200);
    expect((await theRow()).tokenGeneration).toBe(2);
  });

  it("still revokes a sibling refresh of the previous generation that lands after the grace", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const first = await signIn();
    const second = await refreshOk(first);
    await callMe(second);
    await prisma.authSession.updateMany({ data: { rotatedAt: ago(ROTATION_GRACE_MS + 5_000) } });
    expect(await reasonOf(await callRefresh(first))).toBe("reuse");
    expect((await theRow()).revokedReason).toBe("reuse");
  });

  it("repeats the same next token when the refresh response was lost and the old token is refreshed again", async () => {
    const first = await signIn();
    await refreshOk(first);
    const again = await refreshOk(first);
    expect((await callMe(again)).status).toBe(200);
    expect((await theRow()).tokenGeneration).toBe(1);
  });
});

describe("device signature", () => {
  it("accepts a refresh signed by the bound device", async () => {
    const device = newDevice();
    const token = await signIn({ deviceKey: device.publicKey });
    expect((await theRow()).deviceKey).toBe(device.publicKey);
    await refreshOk(token, signRefresh(device, token));
  });

  it("refuses a refresh without a signature, with reason device and no revoke", async () => {
    const device = newDevice();
    const token = await signIn({ deviceKey: device.publicKey });
    expect(await reasonOf(await callRefresh(token))).toBe("device");
    expect((await theRow()).revokedAt).toBeNull();
    expect((await callMe(token)).status).toBe(200);
  });

  it("refuses a signature from another key", async () => {
    const token = await signIn({ deviceKey: newDevice().publicKey });
    expect(await reasonOf(await callRefresh(token, signRefresh(newDevice(), token)))).toBe("device");
  });

  it("refuses a signature made over a different token", async () => {
    const device = newDevice();
    const token = await signIn({ deviceKey: device.publicKey });
    const other = await signIn({ deviceKey: device.publicKey });
    expect(await reasonOf(await callRefresh(token, signRefresh(device, other)))).toBe("device");
  });

  it("refuses a malformed signature", async () => {
    const device = newDevice();
    const token = await signIn({ deviceKey: device.publicKey });
    const headers = { "x-lk-device-time": String(Math.floor(Date.now() / 1000)), "x-lk-device-signature": "not-a-signature" };
    expect(await reasonOf(await callRefresh(token, headers))).toBe("device");
  });

  it("issues nothing for a time more than 300 seconds off, in either direction", async () => {
    const device = newDevice();
    const token = await signIn({ deviceKey: device.publicKey });
    const now = Math.floor(Date.now() / 1000);
    for (const time of [now - 301, now + 301]) {
      const response = await callRefresh(token, signRefresh(device, token, time));
      expect(response.status).toBe(409);
      expect(JSON.stringify(await readJson(response))).not.toContain('"token"');
    }
    await refreshOk(token, signRefresh(device, token, now - 290));
  });

  it("answers the bound device's skewed clock with the server's time, keeps the session, and takes a refresh signed on it", async () => {
    const device = newDevice();
    const token = await signIn({ deviceKey: device.publicKey });
    const phone = Math.floor(Date.now() / 1000) - 3 * 3600;

    const response = await callRefresh(token, signRefresh(device, token, phone));
    expect(response.status).toBe(409);
    const body = await readJson<{ code: string; serverTime: number }>(response);
    expect(body.code).toBe("DEVICE_CLOCK");
    expect(Math.abs(body.serverTime - Math.floor(Date.now() / 1000))).toBeLessThanOrEqual(2);
    expect((await theRow()).revokedAt).toBeNull();
    expect((await callMe(token)).status).toBe(200);

    await refreshOk(token, signRefresh(device, token, body.serverTime));
  });

  it("does not tell a skewed signature from another key anything but device", async () => {
    const token = await signIn({ deviceKey: newDevice().publicKey });
    const skewed = Math.floor(Date.now() / 1000) - 3 * 3600;
    expect(await reasonOf(await callRefresh(token, signRefresh(newDevice(), token, skewed)))).toBe("device");
  });

  it("checks reuse before the signature: a replayed old token is revoked even unsigned", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const device = newDevice();
    const first = await signIn({ deviceKey: device.publicKey });
    const second = await refreshOk(first, signRefresh(device, first));
    await callMe(second);
    await prisma.authSession.updateMany({ data: { rotatedAt: ago(ROTATION_GRACE_MS + 5_000) } });
    expect(await reasonOf(await callRefresh(first))).toBe("reuse");
  });
});

describe("legacy sessions", () => {
  it("works and refreshes unsigned when the row has no device key and the token no gen", async () => {
    const row = await prisma.authSession.create({ data: { userId: user.id, label: "vanha" } });
    const { token } = await sealBearerToken({
      userId: user.id,
      email: user.email,
      firstName: "Testi",
      sessionId: row.id,
    });
    expect((await callMe(token)).status).toBe(200);
    const next = await refreshOk(token);
    expect((await callMe(next)).status).toBe(200);
    expect((await theRow()).tokenGeneration).toBe(1);
  });

  it("an unbound session sign-in (no deviceKey) refreshes unsigned", async () => {
    const token = await signIn();
    expect((await theRow()).deviceKey).toBeNull();
    await refreshOk(token);
  });
});

describe("deviceKey at sign-in", () => {
  it.each([
    ["not base64 of a point", "AAAA"],
    ["a 64-byte value", Buffer.alloc(64, 1).toString("base64")],
    ["a point that is not on the curve", Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString("base64")],
    ["the wrong prefix", Buffer.concat([Buffer.from([2]), Buffer.alloc(64, 7)]).toString("base64")],
    ["a number", 42],
  ])("ignores %s and still signs in unbound", async (_name, deviceKey) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const token = await signIn({ deviceKey });
    expect((await theRow()).deviceKey).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ignoring invalid deviceKey"));
    // Unbound means an unsigned refresh is fine.
    await refreshOk(token);
  });

  it("issues generation 0 tokens that carry the session start", async () => {
    const token = await signIn({ deviceKey: newDevice().publicKey });
    const data = await unsealData<{ gen?: number; sessionStartedAt?: number }>(token, {
      password: sessionOptions.password as string,
    });
    expect(data.gen).toBe(0);
    expect(data.sessionStartedAt).toBe((await theRow()).createdAt.getTime());
  });
});

describe("401 bodies", () => {
  it("me carries the reason and keeps user: null", async () => {
    const response = await me(buildRequest("GET", "/api/auth/me", undefined, { headers: { authorization: "Bearer garbage" } }));
    expect(response.status).toBe(401);
    expect(await readJson(response)).toEqual({
      user: null,
      error: { code: "UNAUTHORIZED", message: "Kirjautuminen vaaditaan", reason: "invalid" },
    });
  });

  it("refresh answers revoked for a signed-out session", async () => {
    const token = await signIn();
    await prisma.authSession.updateMany({ data: { revokedAt: new Date() } });
    expect(await reasonOf(await callRefresh(token))).toBe("revoked");
  });
});

describe("session list", () => {
  it("marks bound devices as trusted and never returns the key", async () => {
    const device = newDevice();
    await signIn({ deviceKey: device.publicKey });
    await signIn();
    const login = await signIn({ deviceKey: device.publicKey });

    const response = await sessionsGet(
      buildRequest("GET", "/api/auth/sessions", undefined, { headers: { authorization: `Bearer ${login}` } })
    );
    const body = await readJson<{ sessions: Array<{ trusted: boolean }> }>(response);
    expect(body.sessions.map((s) => s.trusted).sort()).toEqual([false, true, true]);
    expect(JSON.stringify(body)).not.toContain(device.publicKey);
    expect(JSON.stringify(body)).not.toContain("deviceKey");
  });

  it("does not list a session past the idle or the absolute limit as a signed-in device", async () => {
    await prisma.authSession.create({ data: { userId: user.id, label: "idle", lastSeenAt: ago(SESSION_IDLE_MS + 60_000) } });
    await prisma.authSession.create({
      data: { userId: user.id, label: "old", createdAt: ago(SESSION_ABSOLUTE_MS + 60_000), lastSeenAt: ago(60_000) },
    });
    await prisma.authSession.create({ data: { userId: user.id, label: "edge", lastSeenAt: ago(SESSION_IDLE_MS - 60_000) } });
    const login = await signIn();

    const response = await sessionsGet(
      buildRequest("GET", "/api/auth/sessions", undefined, { headers: { authorization: `Bearer ${login}` } })
    );
    const body = await readJson<{ sessions: Array<{ label: string; current: boolean }> }>(response);
    expect(body.sessions.filter((s) => !s.current).map((s) => s.label)).toEqual(["edge"]);
    expect(body.sessions.filter((s) => s.current)).toHaveLength(1);
  });
});
