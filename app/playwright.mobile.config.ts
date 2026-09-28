import { defineConfig, devices } from "@playwright/test";

/**
 * Exercises the actual static export (npm run build:mobile), served the
 * same way the native router will, against the real dev server on :3200 as
 * the API -- see Global Constraints, "Local verification harness". No
 * managed Next server here: :3200 already runs and must never be started,
 * stopped or restarted by this suite (parallel-rules.md rule 5).
 */
const PORT = 3210;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./tests/e2e-mobile",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    // iPhone 13's device preset selects WebKit; browserName forces Chromium
    // at that phone's viewport, touch, and user agent instead (installed
    // Chrome via the "chrome" channel -- Global Constraints, "Local
    // verification harness").
    ...devices["iPhone 13"],
    browserName: "chromium",
    channel: "chrome",
  },
  webServer: {
    command: "npx tsx scripts/mobile/serve-export.ts",
    url: BASE_URL,
    reuseExistingServer: true,
  },
});
