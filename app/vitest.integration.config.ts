import { defineConfig } from "vitest/config";
import * as path from "path";

/**
 * Integration suite: real SQLite file, real Prisma migrations, real route
 * handlers and real signed session cookies. No mocks - a green run here means
 * the HTTP surface actually behaves.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  test: {
    include: ["tests/integration/**/*.test.ts"],
    globalSetup: ["tests/integration/global-setup.ts"],
    setupFiles: ["tests/integration/setup.ts"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
