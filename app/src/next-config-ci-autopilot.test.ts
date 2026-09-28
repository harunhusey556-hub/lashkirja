import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextConfig } from "next";

// The CI simulator autopilot (src/lib/ci-autopilot/) must never reach a build
// that talks to a real server. next.config.ts is the gate: it inlines the flag
// as a literal and refuses it next to anything but a local http API.
async function loadConfig(env: Record<string, string | undefined>): Promise<NextConfig> {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const configModule = await import("../next.config");
  return configModule.default;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("next.config.ts CI autopilot gate", () => {
  it("refuses the autopilot in a mobile build against an https API", async () => {
    await expect(
      loadConfig({
        BUILD_TARGET: "mobile",
        NEXT_PUBLIC_API_BASE_URL: "https://lashkirja.example.ts.net",
        NEXT_PUBLIC_CI_AUTOPILOT: "1",
      })
    ).rejects.toThrow(/NEXT_PUBLIC_CI_AUTOPILOT=1 is only allowed with a local http API/);
  });

  it("allows it only with a local http API, as the literal \"1\"", async () => {
    const config = await loadConfig({
      BUILD_TARGET: "mobile",
      NEXT_PUBLIC_API_BASE_URL: "http://127.0.0.1:3000",
      NEXT_PUBLIC_CI_AUTOPILOT: "1",
    });
    expect(config.env?.NEXT_PUBLIC_CI_AUTOPILOT).toBe("1");
  });

  it("inlines \"0\" in a normal mobile build", async () => {
    const config = await loadConfig({
      BUILD_TARGET: "mobile",
      NEXT_PUBLIC_API_BASE_URL: "https://lashkirja.example.ts.net",
      NEXT_PUBLIC_CI_AUTOPILOT: undefined,
    });
    expect(config.env?.NEXT_PUBLIC_CI_AUTOPILOT).toBe("0");
  });

  it("treats any value other than \"1\" as off", async () => {
    const config = await loadConfig({
      BUILD_TARGET: "mobile",
      NEXT_PUBLIC_API_BASE_URL: "https://lashkirja.example.ts.net",
      NEXT_PUBLIC_CI_AUTOPILOT: "true",
    });
    expect(config.env?.NEXT_PUBLIC_CI_AUTOPILOT).toBe("0");
  });

  it("never enables it in the web build (what production serves), even with the variable set", async () => {
    const config = await loadConfig({
      BUILD_TARGET: undefined,
      NEXT_PUBLIC_CI_AUTOPILOT: "1",
    });
    expect(config.output).toBeUndefined();
    expect(config.env?.NEXT_PUBLIC_CI_AUTOPILOT).toBe("0");
  });
});
