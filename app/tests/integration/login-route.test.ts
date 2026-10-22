import bcrypt from "bcryptjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
import {
  accountSlowDownMs,
  SLOWDOWN_FREE_FAILURES,
  SLOWDOWN_MAX_MS,
  SLOWDOWN_STEP_MS,
} from "@/lib/auth-login";
import { prisma } from "@/lib/db";
import { resetRateLimitsForTests } from "@/lib/rate-limit";
import { createUser, resetDatabase, type TestUser } from "./helpers/factories";
import { buildFormRequest, buildRequest, readJson } from "./helpers/http";

/**
 * First-run fix (2026-09-28): the login route's JSON branch is what the
 * rewritten LoginForm now talks to via fetch(), instead of relying only on
 * the classic form-POST + 303 redirect. This file locks in the JSON
 * contract the client depends on - status codes, the exact wrong-credentials
 * copy, the Retry-After header on a 429, and no user-enumeration - and
 * checks the pre-existing form-POST fallback still works unchanged.
 */

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

describe("POST /api/auth/login (JSON)", () => {
  it("logs in with correct credentials: 200, ok:true, and a session cookie", async () => {
    const response = await login(
      buildRequest("POST", "/api/auth/login", { email: user.email, password: PASSWORD })
    );
    expect(response.status).toBe(200);
    expect(await readJson<{ ok: boolean }>(response)).toMatchObject({ ok: true });
    const setCookie =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie().join(";")
        : response.headers.get("set-cookie") || "";
    expect(setCookie).toMatch(/lashkirja-session=/);
  });

  it("rejects a wrong password with 401 and the exact inline-alert copy", async () => {
    const response = await login(
      buildRequest("POST", "/api/auth/login", { email: user.email, password: "not-the-password" })
    );
    expect(response.status).toBe(401);
    expect(await readJson<{ error: string }>(response)).toMatchObject({
      error: WRONG_CREDENTIALS_MESSAGE,
    });
  });

  it("rejects an unknown email with the same 401 and the same message (no user enumeration)", async () => {
    const response = await login(
      buildRequest("POST", "/api/auth/login", {
        email: "nobody-here@example.com",
        password: PASSWORD,
      })
    );
    expect(response.status).toBe(401);
    expect(await readJson<{ error: string }>(response)).toMatchObject({
      error: WRONG_CREDENTIALS_MESSAGE,
    });
  });

  it("rejects missing fields with 400 before touching the rate limiter", async () => {
    const response = await login(buildRequest("POST", "/api/auth/login", { email: "", password: "" }));
    expect(response.status).toBe(400);
  });

  it("locks the account after repeated wrong attempts and reports a numeric Retry-After", async () => {
    // The account limiter allows 5 attempts per 15 minutes (route.ts); the
    // 6th must be rejected before authenticate() runs at all.
    let last: Response | undefined;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      last = await login(
        buildRequest("POST", "/api/auth/login", { email: user.email, password: "still-wrong" })
      );
    }
    expect(last?.status).toBe(429);
    const retryAfter = Number(last?.headers.get("Retry-After"));
    expect(Number.isFinite(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
  });

  it("clears the account's rate-limit bucket on a successful login", async () => {
    // Three failures, then a correct login, then straight back to failing:
    // if clearRateLimit() did not run on success this would already be
    // rejected as attempt 5 of the same never-reset bucket.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await login(buildRequest("POST", "/api/auth/login", { email: user.email, password: "wrong" }));
    }
    const success = await login(
      buildRequest("POST", "/api/auth/login", { email: user.email, password: PASSWORD })
    );
    expect(success.status).toBe(200);

    const afterSuccess = await login(
      buildRequest("POST", "/api/auth/login", { email: user.email, password: "wrong-again" })
    );
    expect(afterSuccess.status).toBe(401);
  });
});

describe("POST /api/auth/login (no-JS form fallback)", () => {
  it("still redirects 303 to /dashboard on correct credentials", async () => {
    const form = new FormData();
    form.set("email", user.email);
    form.set("password", PASSWORD);
    const response = await login(buildFormRequest("/api/auth/login", form));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/dashboard");
  });

  it("still redirects 303 to /login?error=auth on a wrong password", async () => {
    const form = new FormData();
    form.set("email", user.email);
    form.set("password", "not-the-password");
    const response = await login(buildFormRequest("/api/auth/login", form));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login?error=auth");
  });
});

describe("POST /api/auth/login behind the proxy: a stranger cannot lock the owner out", () => {
  const STRANGER = "203.0.113.9";
  const OWNER_AT_HOME = "198.51.100.7";

  function loginFrom(client: string, email: string, password: string) {
    return login(
      buildRequest("POST", "/api/auth/login", { email, password }, { headers: { "x-forwarded-for": client } })
    );
  }

  beforeEach(() => {
    process.env.TRUST_PROXY = "true";
  });
  afterEach(() => {
    delete process.env.TRUST_PROXY;
    vi.restoreAllMocks();
  });

  it("keeps the owner's guesses apart from a stranger's, however many the stranger spends", async () => {
    let last: Response | undefined;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      last = await loginFrom(STRANGER, user.email, "guess");
    }
    expect(last?.status).toBe(429);

    const owner = await loginFrom(OWNER_AT_HOME, user.email, PASSWORD);
    expect(owner.status).toBe(200);
  });

  it("still stops the stranger's own address after five wrong guesses at one account", async () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await loginFrom(STRANGER, user.email, "guess")).status).toBe(401);
    }
    // Even the right password is refused from the address that has used its guesses.
    expect((await loginFrom(STRANGER, user.email, PASSWORD)).status).toBe(429);
  });

  it("stops one address that tries many accounts, and leaves the owner's address alone", async () => {
    for (let index = 0; index < 20; index += 1) {
      expect((await loginFrom(STRANGER, `nobody-${index}@example.com`, "guess")).status).toBe(401);
    }
    const limited = await loginFrom(STRANGER, "nobody-20@example.com", "guess");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThan(0);

    expect((await loginFrom(OWNER_AT_HOME, user.email, PASSWORD)).status).toBe(200);
  });

  it("holds back wrong answers once many addresses have guessed at the account, and never the right password", async () => {
    const timeouts = vi.spyOn(globalThis, "setTimeout");
    const waits = () => timeouts.mock.calls.map((call) => call[1]);

    for (let guess = 1; guess <= SLOWDOWN_FREE_FAILURES + 2; guess += 1) {
      expect((await loginFrom(`192.0.2.${guess}`, user.email, "guess")).status).toBe(401);
    }
    expect(waits()).toContain(SLOWDOWN_STEP_MS);
    expect(waits()).toContain(2 * SLOWDOWN_STEP_MS);

    const owner = await loginFrom(OWNER_AT_HOME, user.email, PASSWORD);
    expect(owner.status).toBe(200);
    expect(waits()).not.toContain(3 * SLOWDOWN_STEP_MS);
  });
});

describe("accountSlowDownMs", () => {
  it("is free for the first guesses, then grows a step at a time up to a cap", () => {
    expect(accountSlowDownMs(0)).toBe(0);
    expect(accountSlowDownMs(SLOWDOWN_FREE_FAILURES)).toBe(0);
    expect(accountSlowDownMs(SLOWDOWN_FREE_FAILURES + 1)).toBe(SLOWDOWN_STEP_MS);
    expect(accountSlowDownMs(SLOWDOWN_FREE_FAILURES + 2)).toBe(2 * SLOWDOWN_STEP_MS);
    expect(accountSlowDownMs(10_000)).toBe(SLOWDOWN_MAX_MS);
  });
});
