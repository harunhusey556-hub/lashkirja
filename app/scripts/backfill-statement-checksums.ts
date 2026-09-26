/**
 * One-off backfill: compute Statement.checksum for statements uploaded before
 * the upload route started populating it.
 *
 * Why this matters: duplicate detection compares the sha256 of an incoming file
 * against existing rows. A statement with a null checksum matches nothing, so
 * it can be re-imported once more — duplicating every transaction inside it and
 * therefore the bookkeeping. Backfilling closes that window for existing data.
 *
 * Reports duplicates it finds rather than deleting anything: removing a
 * statement destroys its transactions, which is the owner's decision.
 *
 * Run from the app directory: npx tsx scripts/backfill-statement-checksums.ts
 */
import * as fs from "fs/promises";
import * as path from "path";
import { prisma } from "../src/lib/db";
import { sha256 } from "../src/lib/storage";

function uploadsRoot(): string {
  return path.join(process.cwd(), "data", "uploads");
}

/** Statements predating per-user storage sit flat in data/uploads/. */
async function readStatementFile(
  userId: string,
  filePath: string
): Promise<Buffer | null> {
  const base = path.basename(filePath);
  for (const candidate of [
    path.join(uploadsRoot(), userId, base),
    path.join(uploadsRoot(), base),
  ]) {
    try {
      return await fs.readFile(candidate);
    } catch {
      // try the next location
    }
  }
  return null;
}

async function main() {
  const statements = await prisma.statement.findMany({
    where: { checksum: null },
    select: { id: true, userId: true, fileName: true, filePath: true },
  });

  console.log(`${statements.length} statement(s) without a checksum`);

  let updated = 0;
  let missing = 0;

  for (const s of statements) {
    const buffer = await readStatementFile(s.userId, s.filePath);
    if (!buffer) {
      missing += 1;
      console.warn(`  file missing, skipped: ${s.fileName} (${s.id})`);
      continue;
    }

    const checksum = sha256(buffer);

    // Another statement may already hold this checksum, which means the file
    // was imported twice. The [userId, checksum] unique constraint would reject
    // the write, so report the pair and leave both rows alone.
    const clash = await prisma.statement.findFirst({
      where: { userId: s.userId, checksum, NOT: { id: s.id } },
      select: { id: true, fileName: true },
    });
    if (clash) {
      console.warn(
        `  DUPLICATE: "${s.fileName}" (${s.id}) is the same file as ` +
          `"${clash.fileName}" (${clash.id}) — left untouched, delete one by hand`
      );
      continue;
    }

    await prisma.statement.update({ where: { id: s.id }, data: { checksum } });
    updated += 1;
    console.log(`  ${s.fileName} -> ${checksum.slice(0, 16)}...`);
  }

  console.log(`\nbackfilled ${updated}, missing file ${missing}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
