import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import * as bcrypt from "bcryptjs";

const adapter = new PrismaLibSql({
  url: process.env.DATABASE_URL || "file:../data/lashkirja.db",
});
const prisma = new PrismaClient({ adapter });

async function main() {
  const hash1 = await bcrypt.hash("demo123", 10);
  const hash2 = await bcrypt.hash("demo123", 10);

  await prisma.user.upsert({
    where: { email: "demo@lashkirja.fi" },
    update: {},
    create: {
      email: "demo@lashkirja.fi",
      passwordHash: hash1,
      firstName: "Liisa",
      lastName: "Demo",
      // The demo account is meant to be usable straight away; the onboarding
      // wizard has its own entry point for real sign-ups.
      onboarded: true,
    },
  });

  await prisma.user.upsert({
    where: { email: "anna@lashkirja.fi" },
    update: {},
    create: {
      email: "anna@lashkirja.fi",
      passwordHash: hash2,
      firstName: "Anna",
      lastName: "Yrittäjä",
      onboarded: true,
    },
  });

  console.log("Seed complete: 2 demo users created");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
