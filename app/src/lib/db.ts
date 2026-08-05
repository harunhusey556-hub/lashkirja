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

function hardenLocalDatabasePermissions(dbUrl: string): void {
  if (!dbUrl.startsWith("file:")) return;
  const withoutScheme = decodeURIComponent(dbUrl.slice("file:".length).split("?")[0]);
  if (!withoutScheme || withoutScheme === ":memory:") return;
  const databasePath = path.resolve(process.cwd(), withoutScheme);
  const directory = path.dirname(databasePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  if (fs.existsSync(databasePath)) fs.chmodSync(databasePath, 0o600);
}

export const prisma = globalForPrisma.prisma || createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
