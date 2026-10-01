/**
 * Process account close, data-copy, and password-recovery requests.
 * See app/docs/ops.md. Does not delete receipts or invoices.
 *
 *   npx tsx scripts/account-requests.ts list
 *   npx tsx scripts/account-requests.ts set <id> in_progress
 *   npx tsx scripts/account-requests.ts set <id> needs_info "Puuttuva tieto"
 *   npx tsx scripts/account-requests.ts set <id> denied "Syy"
 *   npx tsx scripts/account-requests.ts set <id> completed
 *   npx tsx scripts/account-requests.ts complete-export <id>
 *   npx tsx scripts/account-requests.ts complete-close <id>
 */
import { prisma } from "../src/lib/db";
import {
  ACCOUNT_REQUEST_STATUSES,
  AccountRequestError,
  type AccountRequestStatus,
  completeAccountClose,
  completeAccountExport,
  setAccountRequestStatus,
} from "../src/lib/account-requests";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main() {
  const [command, id, extra, note] = process.argv.slice(2);
  if (command === "list") {
    const rows = await prisma.accountRequest.findMany({
      orderBy: [{ createdAt: "desc" }],
      take: 100,
      include: { user: { select: { email: true } } },
    });
    for (const row of rows) {
      console.log(
        [row.id, row.status, row.kind, row.user.email, row.packagePath ?? "", row.note ?? ""].join("\t")
      );
    }
    return;
  }
  if (!id) fail("Anna pyynnön id.");
  try {
    if (command === "complete-export") {
      const row = await completeAccountExport(id);
      console.log(`${row.id}\t${row.status}\t${row.packagePath ?? ""}`);
      return;
    }
    if (command === "complete-close") {
      const row = await completeAccountClose(id);
      console.log(`${row.id}\t${row.status}\taccess-disabled`);
      // The bank consent is ended at the bank first; a bank that did not answer
      // is recorded on the request and told here so support can follow it up.
      if (row.note) console.warn(row.note);
      return;
    }
    if (command === "set") {
      if (!ACCOUNT_REQUEST_STATUSES.includes(extra as AccountRequestStatus)) {
        fail(`Tila on yksi seuraavista: ${ACCOUNT_REQUEST_STATUSES.join(", ")}`);
      }
      const row = await setAccountRequestStatus(id, extra as AccountRequestStatus, note);
      console.log(`${row.id}\t${row.status}`);
      return;
    }
  } catch (error) {
    if (error instanceof AccountRequestError) fail(error.message);
    throw error;
  }
  fail("Komento: list | set | complete-export | complete-close");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
