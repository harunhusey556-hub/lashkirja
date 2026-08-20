import { PrismaClient } from "../generated/prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import type { Client, Config } from "@libsql/client";
import * as fs from "fs";
import * as path from "path";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

function createPrismaClient() {
  const configured = process.env.DATABASE_URL?.trim();
  if (process.env.NODE_ENV === "production" && !configured) {
    throw new Error("DATABASE_URL is required in production");
  }
  const dbUrl = configured || "file:../data/lashkirja.db";
  hardenLocalDatabasePermissions(dbUrl);
  const adapter = new HardenedPrismaLibSql({
    url: dbUrl,
  });
  return new PrismaClient({ adapter });
}

class HardenedPrismaLibSql extends PrismaLibSql {
  override createClient(config: Config): Client {
    const client = super.createClient(config);
    if (config.url.startsWith("file:")) {
      // journal_mode persists on the database. busyTimeout above applies to
      // every connection, including connections reopened after transactions.
      void client.execute("PRAGMA journal_mode = WAL").catch((error) => {
        console.error("SQLite WAL initialization failed:", error);
      });
      void client.execute("PRAGMA foreign_keys = ON").catch((error) => {
        console.error("SQLite foreign key initialization failed:", error);
      });
    }
    return client;
  }
}

/**
 * Tightening permissions is a precaution, not a precondition for running.
 * A database placed in a directory this process does not own (/tmp in test
 * environments, a shared mount in production) cannot be chmodded, and letting
 * that throw took the whole process down: every database-backed request
 * answered 500 because the Prisma client could not even be constructed.
 */
function tightenPermissions(target: string, mode: number): void {
  try {
    fs.chmodSync(target, mode);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EACCES" && code !== "ENOENT") throw error;
    console.warn(
      `SQLite permission hardening skipped for ${target} (${code}). ` +
        "Verify the file is not world-readable."
    );
  }
}

export function hardenLocalDatabasePermissions(dbUrl: string): void {
  if (!dbUrl.startsWith("file:")) return;
  const withoutScheme = decodeURIComponent(dbUrl.slice("file:".length).split("?")[0]);
  if (!withoutScheme || withoutScheme === ":memory:") return;
  const databasePath = path.resolve(process.cwd(), withoutScheme);
  const directory = path.dirname(databasePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  tightenPermissions(directory, 0o700);
  if (fs.existsSync(databasePath)) tightenPermissions(databasePath, 0o600);
}

export const prisma = globalForPrisma.prisma || createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
