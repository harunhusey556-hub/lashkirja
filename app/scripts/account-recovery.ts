/**
 * Prints one password-reset link for a user who cannot receive mail.
 * See app/docs/account-recovery.md. Does not print or set a password.
 *
 *   npx tsx scripts/account-recovery.ts kayttaja@example.com
 */
import { prisma } from "../src/lib/db";
import { issuePasswordReset } from "../src/lib/account-security";

async function main() {
  const email = process.argv[2]?.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    console.error("Anna sähköposti: npx tsx scripts/account-recovery.ts kayttaja@example.com");
    process.exit(1);
  }
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (!user) {
    console.error("Käyttäjää ei löydy.");
    process.exit(1);
  }
  const token = await issuePasswordReset(user.id);
  const origin = process.env.APP_ORIGIN?.replace(/\/$/, "") || "";
  console.log(`${origin}/palauta-salasana?token=${token}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
