import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

/**
 * Per-file database. Runs before the test module (and therefore before
 * src/lib/db.ts) is imported, so the Prisma singleton picks up this URL.
 */
const tmpDir = path.resolve(__dirname, "../.tmp");
const template =
  process.env.LK_TEST_TEMPLATE_DB || path.join(tmpDir, "template.db");

if (!fs.existsSync(template)) {
  throw new Error(
    `Template database missing at ${template}. Run the integration config, not the unit config.`
  );
}

const dbPath = path.join(tmpDir, `test-${randomUUID()}.db`);
fs.copyFileSync(template, dbPath);

process.env.DATABASE_URL = `file:${dbPath}`;
process.env.SESSION_SECRET = "integration-test-session-secret-0123456789";
process.env.COOKIE_SECURE = "false";
delete process.env.APP_ORIGIN;

// A worker may run several test files; drop any Prisma client cached by an
// earlier file so it cannot keep writing to that file's database.
delete (globalThis as unknown as { prisma?: unknown }).prisma;

process.on("exit", () => {
  for (const suffix of ["", "-wal", "-shm"]) {
    fs.rmSync(`${dbPath}${suffix}`, { force: true });
  }
});
