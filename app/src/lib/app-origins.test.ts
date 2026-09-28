import { describe, expect, it } from "vitest";
import {
  API_VERSION,
  appClientOrigins,
  corsPreflightHeaders,
  corsResponseHeaders,
  DEV_EMULATION_ORIGIN,
  isAppClientOrigin,
} from "./app-origins";

function env(overrides: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "development", ...overrides } as NodeJS.ProcessEnv;
}

describe("appClientOrigins", () => {
  it("defaults to capacitor://localhost plus the dev emulation origin outside production", () => {
    expect(appClientOrigins(env())).toEqual(["capacitor://localhost", DEV_EMULATION_ORIGIN]);
  });

  it("omits the dev emulation origin in production", () => {
    expect(appClientOrigins(env({ NODE_ENV: "production" }))).toEqual(["capacitor://localhost"]);
  });

  it("splits and trims MOBILE_APP_ORIGINS", () => {
    expect(
      appClientOrigins(env({ MOBILE_APP_ORIGINS: " capacitor://localhost , https://custom.app  ,, " }))
    ).toEqual(["capacitor://localhost", "https://custom.app", DEV_EMULATION_ORIGIN]);
  });

  it("falls back to the default when MOBILE_APP_ORIGINS is empty or unset", () => {
    expect(appClientOrigins(env({ MOBILE_APP_ORIGINS: "" }))).toEqual([
      "capacitor://localhost",
      DEV_EMULATION_ORIGIN,
    ]);
    expect(appClientOrigins(env({ MOBILE_APP_ORIGINS: undefined }))).toEqual([
      "capacitor://localhost",
      DEV_EMULATION_ORIGIN,
    ]);
  });
});

describe("isAppClientOrigin", () => {
  it("allows the default app origin", () => {
    expect(isAppClientOrigin("capacitor://localhost", env())).toBe(true);
  });

  it("allows the emulation origin in development but refuses it in production", () => {
    expect(isAppClientOrigin(DEV_EMULATION_ORIGIN, env())).toBe(true);
    expect(isAppClientOrigin(DEV_EMULATION_ORIGIN, env({ NODE_ENV: "production" }))).toBe(false);
  });

  it("refuses null, missing, and lookalike origins", () => {
    expect(isAppClientOrigin(null, env())).toBe(false);
    expect(isAppClientOrigin("null", env())).toBe(false);
    expect(isAppClientOrigin("http://capacitor.localhost", env())).toBe(false);
    expect(isAppClientOrigin("capacitor://localhost.evil", env())).toBe(false);
    expect(isAppClientOrigin("capacitor://localhost:1234", env())).toBe(false);
  });

  it("requires an exact match, not a prefix or substring", () => {
    expect(isAppClientOrigin("https://custom.app.evil.test", env({ MOBILE_APP_ORIGINS: "https://custom.app" }))).toBe(
      false
    );
  });
});

describe("corsPreflightHeaders / corsResponseHeaders", () => {
  it("echoes the given origin and never uses a wildcard", () => {
    const preflight = corsPreflightHeaders("capacitor://localhost");
    expect(preflight["Access-Control-Allow-Origin"]).toBe("capacitor://localhost");
    expect(preflight["Access-Control-Allow-Methods"]).toBe("GET, POST, PUT, PATCH, DELETE, OPTIONS");
    expect(preflight["Access-Control-Allow-Headers"]).toBe("Authorization, Content-Type, Idempotency-Key, Accept");
    expect(preflight["Access-Control-Max-Age"]).toBe("600");
    expect(preflight.Vary).toBe("Origin");
    expect(preflight["Access-Control-Allow-Credentials"]).toBeUndefined();

    const response = corsResponseHeaders("capacitor://localhost");
    expect(response["Access-Control-Allow-Origin"]).toBe("capacitor://localhost");
    expect(response["Access-Control-Expose-Headers"]).toBe(
      "Retry-After, Content-Disposition, X-LashKirja-Api-Version"
    );
    expect(response.Vary).toBe("Origin");
    expect(response["Access-Control-Allow-Credentials"]).toBeUndefined();
  });
});

describe("API_VERSION", () => {
  it("is 1", () => {
    expect(API_VERSION).toBe(1);
  });
});
