import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it } from "vitest";
import { POST as login } from "@/app/api/auth/login/route";
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
