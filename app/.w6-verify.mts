/**
 * Scratch: prepare a throwaway DB for the W6 UI check (temp file, never the
 * repo's DB). Applies the migration SQL directly with libsql and seeds the
 * demo user plus one tiliote. Deleted after the verification run.
 */
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { createClient } from "@libsql/client";
import { PrismaClient } from "./src/generated/prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import * as bcrypt from "bcryptjs";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");

const migrations = path.resolve("prisma/migrations");
const client = createClient({ url });
const dirs = readdirSync(migrations)
  .filter((name) => /^\d{14}_/.test(name))
  .sort();

const applied = await client.execute(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='User'"
);
if (applied.rows.length === 0) {
  for (const dir of dirs) {
    const sql = readFileSync(path.join(migrations, dir, "migration.sql"), "utf8");
    await client.executeMultiple(sql);
  }
  console.log(`applied ${dirs.length} migrations to ${url}`);
} else {
  console.log(`already migrated: ${url}`);
}

const prisma = new PrismaClient({ adapter: new PrismaLibSql({ url }) });
const user = await prisma.user.upsert({
  where: { email: "demo@lashkirja.fi" },
  update: {},
  create: {
    email: "demo@lashkirja.fi",
    passwordHash: await bcrypt.hash("demo123", 10),
    firstName: "Liisa",
    lastName: "Demo",
  },
});

const existing = await prisma.statement.findFirst({ where: { userId: user.id } });
if (!existing) {
  const statement = await prisma.statement.create({
    data: {
      userId: user.id,
      fileName: "tiliote-syyskuu.csv",
      fileType: "csv",
      filePath: "verify/tiliote-syyskuu.csv",
      periodMonth: "2026-09",
      checksum: "w6-verify-checksum",
    },
  });
  console.log(`seeded statement ${statement.id}`);
}
await prisma.$disconnect();
