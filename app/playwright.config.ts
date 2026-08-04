import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";

const port = 3791;
const managedBaseUrl = `http://127.0.0.1:${port}`;
const externalBaseUrl = process.env.PLAYWRIGHT_BASE_URL;
const testDatabase = `file:/tmp/lashkirja-e2e-${process.pid}.db`;
const chromiumPath = [
  process.env.PLAYWRIGHT_CHROMIUM_PATH,
  "/snap/bin/chromium",
  "/usr/bin/chromium",
  "/usr/bin/google-chrome",
].find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: externalBaseUrl || managedBaseUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    launchOptions: chromiumPath ? { executablePath: chromiumPath } : undefined,
  },
  projects: [
    {
      name: "mobile-chromium",
      use: { ...devices["iPhone 13"] },
    },
  ],
  webServer: externalBaseUrl
    ? undefined
    : {
        command: `npx prisma migrate deploy && npx tsx prisma/seed.ts && npm start -- -p ${port}`,
        url: managedBaseUrl,
        reuseExistingServer: false,
        timeout: 120_000,
        env: {
          DATABASE_URL: testDatabase,
          SESSION_SECRET:
            "lashkirja-e2e-session-secret-64-characters-minimum-000000000000",
          COOKIE_SECURE: "false",
          CLOUD_AI_ENABLED: "false",
          LLM_API_KEY: "",
          COPILOT_GITHUB_TOKEN: "",
        },
      },
});
