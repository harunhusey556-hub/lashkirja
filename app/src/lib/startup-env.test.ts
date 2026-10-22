import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertStartupEnv } from "./startup-env";

const LONG_SECRET = "ci-only-secret-not-used-anywhere-real-32plus";
const MESSAGE = /SESSION_SECRET must be configured with at least 32 characters in production/;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("assertStartupEnv", () => {
  it("refuses production without a SESSION_SECRET, with a blank one, and with one under 32 characters", () => {
    for (const SESSION_SECRET of [undefined, "", "   ", "x".repeat(31), `  ${"x".repeat(31)}  `]) {
      expect(() => assertStartupEnv({ NODE_ENV: "production", SESSION_SECRET })).toThrow(MESSAGE);
    }
  });

  it("accepts production with a secret of 32 characters or more", () => {
    expect(() => assertStartupEnv({ NODE_ENV: "production", SESSION_SECRET: "x".repeat(32) })).not.toThrow();
  });

  it("leaves development and test alone, where the development secret is the point", () => {
    for (const NODE_ENV of ["development", "test", undefined]) {
      expect(() => assertStartupEnv({ NODE_ENV, SESSION_SECRET: undefined })).not.toThrow();
    }
  });
});

describe("encryption.ts", () => {
  it("does not fall back to the development secret in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", "");
    await expect(import("./encryption")).rejects.toThrow(MESSAGE);
  });

  it("encrypts and decrypts with a real secret in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SESSION_SECRET", LONG_SECRET);
    const { encrypt, decrypt } = await import("./encryption");
    expect(decrypt(encrypt("app-password"))).toBe("app-password");
  });

  it("still works without a secret outside production", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("SESSION_SECRET", "");
    const { encrypt, decrypt } = await import("./encryption");
    expect(decrypt(encrypt("app-password"))).toBe("app-password");
  });
});

describe("the entry points", () => {
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

  it("the server checks at start-up, before it answers a request", () => {
    expect(read("src/instrumentation.ts")).toContain("assertStartupEnv()");
  });

  it("the worker exits non-zero in production without a SESSION_SECRET", () => {
    expect(read("scripts/worker.ts")).toMatch(/^assertStartupEnv\(\);$/m);

    const result = spawnSync(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "--tsconfig", "tsconfig.json", "scripts/worker.ts"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: "production",
          SESSION_SECRET: "",
          DATABASE_URL: process.env.DATABASE_URL || "file:./ci-check.db",
        },
        encoding: "utf8",
        // A worker that did start would keep running; the timeout turns that into a failure.
        timeout: 60_000,
      }
    );
    expect(result.stderr).toMatch(MESSAGE);
    expect(result.status).not.toBe(0);
    expect(result.status).not.toBeNull();
  }, 90_000);
});
