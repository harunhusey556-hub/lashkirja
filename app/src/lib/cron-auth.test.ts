import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { checkCronAuth } from "./cron-auth";

afterEach(() => {
  vi.unstubAllEnvs();
});

function request(headers: Record<string, string> = {}, query = "") {
  return new NextRequest(new URL(`http://localhost:3000/api/cron/x${query}`), { headers });
}

function setEnv(value: string) {
  vi.stubEnv("NODE_ENV", value);
}

describe("checkCronAuth with a configured secret", () => {
  it("accepts the bearer token", () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(checkCronAuth(request({ authorization: "Bearer s3cret" })).ok).toBe(true);
  });

  it("accepts the query parameter, which is what most schedulers can send", () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(checkCronAuth(request({}, "?secret=s3cret")).ok).toBe(true);
  });

  it("rejects a wrong, missing or malformed token", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    for (const attempt of [
      request(),
      request({ authorization: "Bearer wrong" }),
      request({ authorization: "s3cret" }),
      request({}, "?secret=wrong"),
    ]) {
      const result = checkCronAuth(attempt);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(401);
    }
  });
});

describe("checkCronAuth without a configured secret", () => {
  it("allows a local developer to trigger the route", () => {
    vi.stubEnv("CRON_SECRET", "");
    setEnv("development");
    expect(checkCronAuth(request()).ok).toBe(true);
  });

  it("refuses in production instead of running unauthenticated", () => {
    vi.stubEnv("CRON_SECRET", "");
    setEnv("production");
    const result = checkCronAuth(request());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(500);
  });

  it("treats a blank secret as no secret", () => {
    vi.stubEnv("CRON_SECRET", "   ");
    setEnv("production");
    expect(checkCronAuth(request({ authorization: "Bearer    " })).ok).toBe(false);
  });
});
