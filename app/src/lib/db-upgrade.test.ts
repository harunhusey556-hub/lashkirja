import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = process.cwd();
const prismaBin = path.join(appRoot, "node_modules", ".bin", "prisma");
const waveI = "20260927060000_wave_i_account";

function sqlite(db: string, sql: string): string {
  return execFileSync("sqlite3", [db, sql], { encoding: "utf8" }).trim();
}

function migrate(cwd: string, dbFile: string): void {
  execFileSync(prismaBin, ["migrate", "deploy"], {
    cwd,
    env: { ...process.env, DATABASE_URL: `file:${dbFile}` },
    stdio: "pipe",
  });
}

describe("database upgrade", () => {
  it(
    "migrates a previous schema that already has a user, and a failed deploy leaves that user",
    () => {
      const root = mkdtempSync(path.join(tmpdir(), "lashkirja-upgrade-"));
      const db = path.join(root, "prev.db");
      migrate(appRoot, db);

      sqlite(
        db,
        [
          "PRAGMA foreign_keys=OFF;",
          'DROP TABLE IF EXISTS "AccountRequest";',
          'DROP TABLE IF EXISTS "AccountToken";',
          'DROP TABLE IF EXISTS "AuthSession";',
          'ALTER TABLE "User" DROP COLUMN "pendingEmail";',
          `DELETE FROM "_prisma_migrations" WHERE migration_name = '${waveI}';`,
        ].join(" ")
      );
      expect(sqlite(db, 'PRAGMA table_info("User");')).not.toContain("pendingEmail");
      sqlite(
        db,
        `INSERT INTO "User" (id, email, passwordHash, firstName, lastName) VALUES ('user-upgrade-1', 'upgrade@example.com', 'hash', 'Vanha', 'Tili');`
      );

      migrate(appRoot, db);
      expect(sqlite(db, `SELECT email FROM "User" WHERE id = 'user-upgrade-1';`)).toBe(
        "upgrade@example.com"
      );
      expect(sqlite(db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'AuthSession';`)).toBe(
        "AuthSession"
      );
      expect(sqlite(db, 'PRAGMA table_info("User");')).toContain("pendingEmail");

      const failDb = path.join(root, "fail.db");
      execFileSync("cp", [db, failDb]);
      const project = path.join(root, "project");
      mkdirSync(path.join(project, "prisma"), { recursive: true });
      cpSync(path.join(appRoot, "prisma", "schema.prisma"), path.join(project, "prisma", "schema.prisma"));
      cpSync(path.join(appRoot, "prisma", "migrations"), path.join(project, "prisma", "migrations"), {
        recursive: true,
      });
      const failDir = path.join(project, "prisma", "migrations", "20260927999999_failed_deploy");
      mkdirSync(failDir);
      writeFileSync(
        path.join(failDir, "migration.sql"),
        [
          'CREATE TABLE "ShouldNotExist" ("id" TEXT NOT NULL PRIMARY KEY);',
          'SELECT * FROM "ThisTableDoesNotExist";',
          "",
        ].join("\n")
      );
      writeFileSync(
        path.join(project, "prisma.config.ts"),
        [
          'import { defineConfig } from "prisma/config";',
          "export default defineConfig({",
          '  schema: "prisma/schema.prisma",',
          '  migrations: { path: "prisma/migrations" },',
          "  datasource: { url: process.env.DATABASE_URL },",
          "});",
          "",
        ].join("\n")
      );

      let failed = false;
      try {
        execFileSync(prismaBin, ["migrate", "deploy"], {
          cwd: project,
          env: {
            ...process.env,
            DATABASE_URL: `file:${failDb}`,
            NODE_PATH: path.join(appRoot, "node_modules"),
          },
          stdio: "pipe",
        });
      } catch {
        failed = true;
      }
      expect(failed).toBe(true);
      expect(sqlite(failDb, `SELECT email FROM "User" WHERE id = 'user-upgrade-1';`)).toBe(
        "upgrade@example.com"
      );
      // SQLite can keep statements that ran before the error. The migration
      // must not be recorded as finished. Restore the snapshot instead of
      // serving this file. See app/docs/deploy-rollback.md.
      expect(
        sqlite(
          failDb,
          `SELECT COALESCE(finished_at, '') FROM "_prisma_migrations" WHERE migration_name = '20260927999999_failed_deploy';`
        )
      ).toBe("");
    },
    180_000
  );
});