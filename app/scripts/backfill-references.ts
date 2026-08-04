/**
 * One-off backfill: extract viitenumero / laskun numero from stored rawText
 * into the new Receipt.reference / invoiceNumber columns (no AI calls), then
 * run the matcher once per user so existing data gets suggestions.
 *
 * Run from the app directory: npx tsx scripts/backfill-references.ts
 */
import { prisma } from "../src/lib/db";
import { extractReferenceFields } from "../src/lib/ai";
import { runMatching } from "../src/lib/matching";

async function main() {
  const receipts = await prisma.receipt.findMany({
    where: { rawText: { not: null }, reference: null, invoiceNumber: null },
    select: { id: true, fileName: true, rawText: true },
  });

  let updated = 0;
  for (const r of receipts) {
    const { reference, invoiceNumber } = extractReferenceFields(r.rawText!);
    if (reference || invoiceNumber) {
      await prisma.receipt.update({
        where: { id: r.id },
        data: { reference, invoiceNumber },
      });
      updated++;
      console.log(
        `${r.fileName}: viite=${reference ?? "-"} laskunro=${invoiceNumber ?? "-"}`
      );
    }
  }
  console.log(`Backfilled ${updated}/${receipts.length} receipts`);

  const users = await prisma.user.findMany({
    select: { id: true, email: true },
  });
  for (const u of users) {
    const suggestions = await runMatching(u.id);
    console.log(`${u.email}: ${suggestions} match suggestion(s)`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
