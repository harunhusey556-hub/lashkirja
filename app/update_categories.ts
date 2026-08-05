import { PrismaClient } from './src/generated/prisma';

const prisma = new PrismaClient();

async function main() {
  const result = await prisma.receipt.updateMany({
    where: { category: "Myynti" },
    data: { category: "myynti" }
  });
  console.log(`Updated ${result.count} receipts`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
