// Same as app/playwright.mobile.config.ts, minus the webServer (the shim
// serves the export), plus the harness tsconfig. Run from app/:
//   EXPORT_ROOT=<out dir> npx playwright test -c ../.superpowers/quality/batch-3/laneB/harness/playwright.harness.config.ts
import path from "node:path";
import { defineConfig, devices } from "../../../../../app/node_modules/@playwright/test/index.js";

export default defineConfig({
  testDir: path.resolve(__dirname, "../../../../../app/tests/e2e-mobile"),
  tsconfig: path.resolve(__dirname, "tsconfig.json"),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: "http://127.0.0.1:3210",
    trace: "off",
    screenshot: "off",
    ...devices["iPhone 13"],
    browserName: "chromium",
    channel: "chrome",
  },
});
