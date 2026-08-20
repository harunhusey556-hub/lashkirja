/**
 * One-off cleanup: remove duplicate auto_income drafts.
 *
 * Drafts are not linked to their bank row, so every matching run saw the same
 * transactions as still unmatched and drafted them again — 54 drafts for 18
 * transactions. Generation is now idempotent via Receipt.sourceTransactionId,
 * but the copies already written need clearing out.
 *
 * Only touches receipts with source="auto_income" AND reviewStatus="pending".
 * Anything approved, rejected, linked to a transaction, or from another source
 * is left alone — those represent human decisions.
 *
 * Groups by (date, totalAmountCents, vendor), keeps the oldest of each group,
 * and backfills sourceTransactionId on the survivor where it can be matched to
 * a bank row unambiguously.
 *
 * Dry run by default. Pass --apply to delete.
 *
 * Run from the app directory: npx tsx scripts/dedupe-auto-income-drafts.ts
 */
import { prisma } from "../src/lib/db";

const APPLY = process.argv.includes("--apply");

function groupKey(r: {
  date: Date | null;
  totalAmountCents: number | null;
  vendor: string | null;
}): string {
  return [
    r.date ? r.date.toISOString().slice(0, 10) : "nodate",
    r.totalAmountCents ?? "noamount",
    r.vendor ?? "novendor",
  ].join("|");
}

async function main() {
  const drafts = await prisma.receipt.findMany({
    where: {
      source: "auto_income",
      reviewStatus: "pending",
      linkedTransaction: null,
    },
    select: {
      id: true,
      date: true,
      totalAmountCents: true,
      vendor: true,
      createdAt: true,
      sourceTransactionId: true,
      userId: true,
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(`${drafts.length} pending auto_income draft(s)`);

  const groups = new Map<string, typeof drafts>();
  for (const d of drafts) {
    const key = `${d.userId}|${groupKey(d)}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(d);
    else groups.set(key, [d]);
  }

  const doomed: string[] = [];
  for (const [key, bucket] of groups) {
    if (bucket.length <= 1) continue;

    // Two genuine payments can share a date and amount — the July 9th 60,00 €
    // group held six drafts because there were two real bank rows, each drafted
    // three times. Keep one draft per matching bank row, not one per group,
    // otherwise this deletes legitimate drafts.
    const bankRows = await prisma.transaction.count({
      where: {
        statement: { userId: bucket[0].userId },
        type: "tulo",
        amountCents: bucket[0].totalAmountCents ?? undefined,
        date: bucket[0].date ?? undefined,
      },
    });
    const keepCount = Math.max(1, Math.min(bankRows, bucket.length));
    if (bucket.length === keepCount) continue;

    // orderBy createdAt asc above means the earliest are the originals
    const extra = bucket.slice(keepCount);
    console.log(
      `  ${key}: ${bucket.length} drafts, ${bankRows} bank row(s) -> keeping ${keepCount}, removing ${extra.length}`
    );
    doomed.push(...extra.map((e) => e.id));
  }

  console.log(
    `\n${groups.size} distinct group(s), ${doomed.length} duplicate(s) to remove`
  );

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to delete.");
    return;
  }

  const deleted = await prisma.receipt.deleteMany({ where: { id: { in: doomed } } });
  console.log(`deleted ${deleted.count}`);

  // Backfill provenance on survivors so future runs recognise them.
  let linked = 0;
  for (const [, bucket] of groups) {
    const keep = bucket[0];
    if (keep.sourceTransactionId) continue;
    const candidates = await prisma.transaction.findMany({
      where: {
        statement: { userId: keep.userId },
        type: "tulo",
        amountCents: keep.totalAmountCents ?? undefined,
        date: keep.date ?? undefined,
      },
      select: { id: true },
    });
    // Only when it maps to exactly one bank row; a guess here would be wrong.
    if (candidates.length !== 1) continue;
    const taken = await prisma.receipt.findFirst({
      where: { sourceTransactionId: candidates[0].id },
      select: { id: true },
    });
    if (taken) continue;
    await prisma.receipt.update({
      where: { id: keep.id },
      data: { sourceTransactionId: candidates[0].id },
    });
    linked += 1;
  }
  console.log(`backfilled sourceTransactionId on ${linked} survivor(s)`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
