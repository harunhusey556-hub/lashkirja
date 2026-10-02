import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

/**
 * Builds one migrated template database. Each test file copies it, so the
 * expensive `prisma migrate deploy` runs once per suite instead of per file.
 */
export default function setup() {
  const tmpDir = path.resolve(__dirname, "../.tmp");
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  const templatePath = path.join(tmpDir, "template.db");
  // Initialise the SQLite file before migration; some schema-engine builds
  // cannot create a missing database and return an empty error instead.
  fs.closeSync(fs.openSync(templatePath, "a"));
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DATABASE_URL: `file:${templatePath}` },
    stdio: "pipe",
    // Windows resolves `npx` only through the shell (npx.cmd).
    shell: process.platform === "win32",
  });

  if (!fs.existsSync(templatePath)) {
    throw new Error(`Template database was not created at ${templatePath}`);
  }
  process.env.LK_TEST_TEMPLATE_DB = templatePath;
}
