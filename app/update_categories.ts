import { prisma } from './src/lib/db';

async function main() {
  const result = await prisma.receipt.updateMany({
    where: { category: "Myynti" },
    data: { category: "myynti" }
  });
  console.log(`Updated ${result.count} receipts`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
