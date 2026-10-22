/**
 * Audit walk only (branch audit/phase2-walk, ExploratoryWalkTests): rows `demo-seed.ts --ci`
 * does not have, so the walk can reach "Kohdista varmat (N)" → "Kumoa" in Kuitit → Ei
 * kohdistettu, and a credit note (hyvityslasku). Run after `demo-seed.ts --ci` and before the
 * workflow gives the receipts their pictures, so these receipts get one too.
 *
 * Idempotent: every row is looked up by its own file name, checksum or counterparty before it
 * is created, so a second run (or a run after a partial one) adds only what is missing.
 *
 * Never point this at a real database - it assumes it owns the demo user's data.
 */
import "dotenv/config";
import type { Prisma } from "../src/generated/prisma/client";
import { prisma } from "../src/lib/db";
import { encodeMatchReasons, scorePair } from "../src/lib/matching";
import { centsToEuros } from "../src/lib/money";

function isoDaysAgo(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

const day = (n: number) => new Date(`${isoDaysAgo(n)}T00:00:00Z`);
const vat = (eur: number) => JSON.stringify([{ rate: 25.5, amount: eur }]);

const DEMO_EMAIL = "demo@lashkirja.fi";
const STATEMENT_CHECKSUM = "demo-audit-checksum";

type ReceiptSeed = Omit<Prisma.ReceiptUncheckedCreateInput, "userId" | "fileName" | "filePath">;

async function ensureReceipt(userId: string, fileName: string, data: ReceiptSeed) {
  const existing = await prisma.receipt.findFirst({ where: { userId, fileName } });
  if (existing) return existing;
  return prisma.receipt.create({
    data: {
      userId,
      fileName,
      // A name the CI picture step replaces with a stored JPEG, as it does for demo-seed's rows.
      filePath: `/tmp/${fileName}`,
      type: "meno",
      category: "tarvikkeet",
      reviewStatus: "approved",
      ...data,
    },
  });
}

type TransactionSeed = Omit<Prisma.TransactionUncheckedCreateInput, "statementId" | "counterparty">;

async function ensureTransaction(statementId: string, counterparty: string, data: TransactionSeed) {
  const existing = await prisma.transaction.findFirst({ where: { statementId, counterparty } });
  if (existing) return existing;
  return prisma.transaction.create({ data: { statementId, counterparty, type: "meno", ...data } });
}

/**
 * A bank row the server will list as a sure pair: viite + exact amount (the gate's `certain`)
 * against `receipt`, stored as the matcher stores a suggestion. The rival receipt of the same
 * name and amount makes the pair "competing", so a matching run that a receipt save starts keeps
 * it suggested instead of linking it by itself (autoLinkSureMatches is off for the demo user).
 */
async function ensureSurePair(
  statementId: string,
  receipt: { id: string; vendor: string | null; date: Date | null; totalAmountCents: number | null; type: string; reference: string | null; invoiceNumber: string | null },
  row: { date: Date; counterparty: string; reference: string; message: string }
) {
  const amountCents = -(receipt.totalAmountCents ?? 0);
  const fresh = scorePair(
    { id: "audit", date: row.date, counterparty: row.counterparty, amount: centsToEuros(amountCents), reference: row.reference, message: row.message, type: "meno" },
    { ...receipt, totalAmount: receipt.totalAmountCents == null ? null : centsToEuros(receipt.totalAmountCents) }
  );
  if (!fresh?.certain) {
    // Recorded, not fatal: the walk then records "Kohdista varmat" as missing.
    console.warn(`::warning::audit seed: ${row.counterparty} / ${receipt.vendor} is not a certain pair under today's gate (${JSON.stringify(fresh)})`);
  }
  return ensureTransaction(statementId, row.counterparty, {
    date: row.date,
    amountCents,
    reference: row.reference,
    message: row.message,
    matchStatus: "suggested",
    suggestedReceiptId: receipt.id,
    matchScore: fresh?.score ?? null,
    matchReasons: fresh ? encodeMatchReasons([...fresh.reasons, "competing"], fresh.explanation) : null,
  });
}

async function main() {
  const user = await prisma.user.findUnique({ where: { email: DEMO_EMAIL } });
  if (!user) throw new Error(`audit seed: ${DEMO_EMAIL} is missing; run scripts/demo-seed.ts --ci first`);
  const account = await prisma.bankAccount.findFirst({ where: { userId: user.id, isDefault: true } });

  // Credit notes first: they need nothing else, so a later failure still leaves them in place.
  // A credit note is a receipt with a negative total and negative VAT (api/receipts/save).
  await ensureReceipt(user.id, "audit-hyvitys.pdf", {
    vendor: "Audit Hyvitys Oy",
    date: day(6),
    totalAmountCents: -5_000,
    vatDetails: vat(-10.16),
    invoiceNumber: "HYV-2026-1",
    notes: "Hyvityslasku",
  });
  await ensureReceipt(user.id, "audit-hyvitys-odottaa.pdf", {
    vendor: "Audit Hyvitys Odottaa Oy",
    date: day(2),
    totalAmountCents: -1_890,
    vatDetails: vat(-3.84),
    notes: "Hyvityslasku",
    reviewStatus: "pending",
  });

  // Two sure pairs (the plural toasts "2 kuittia kohdistettu." / "2 kohdistusta kumottu."),
  // each with a rival receipt that keeps it suggested.
  const tukku = await ensureReceipt(user.id, "audit-tukku.pdf", {
    vendor: "Audit Tukku Oy",
    date: day(5),
    totalAmountCents: 8_765,
    reference: "1234567",
    vatDetails: vat(17.81),
  });
  await ensureReceipt(user.id, "audit-tukku-kopio.pdf", {
    vendor: "Audit Tukku",
    date: day(5),
    totalAmountCents: 8_765,
    vatDetails: vat(17.81),
  });
  const kahvila = await ensureReceipt(user.id, "audit-kahvila.pdf", {
    vendor: "Audit Kahvila Oy",
    date: day(3),
    totalAmountCents: 3_450,
    reference: "7654321",
    vatDetails: vat(7.01),
  });
  await ensureReceipt(user.id, "audit-kahvila-kopio.pdf", {
    vendor: "Audit Kahvila",
    date: day(3),
    totalAmountCents: 3_450,
    vatDetails: vat(7.01),
  });

  const statement =
    (await prisma.statement.findFirst({ where: { userId: user.id, checksum: STATEMENT_CHECKSUM } })) ??
    (await prisma.statement.create({
      data: {
        userId: user.id,
        bankAccountId: account?.id ?? null,
        fileName: "tiliote-audit.csv",
        fileType: "csv",
        filePath: "/tmp/demo-audit.csv",
        checksum: STATEMENT_CHECKSUM,
        periodMonth: isoDaysAgo(4).slice(0, 7),
      },
    }));

  await ensureSurePair(statement.id, tukku, { date: day(4), counterparty: "Audit Tukku Oy", reference: "1234567", message: "Lasku 1234567" });
  await ensureSurePair(statement.id, kahvila, { date: day(2), counterparty: "Audit Kahvila Oy", reference: "7654321", message: "Viite 7654321" });

  // Free rows that equal no receipt amount: the bank picker passes its first server page (30),
  // and the walk links its uploaded receipt to one of them without touching the sure pairs.
  for (const [counterparty, amountCents] of [["Audit Täyte 1", -1_234], ["Audit Täyte 2", -2_345], ["Audit Täyte 3", -4_567]] as const) {
    await ensureTransaction(statement.id, counterparty, { date: day(1), amountCents });
  }

  const sure = await prisma.transaction.count({ where: { statementId: statement.id, matchStatus: "suggested" } });
  console.log(`Audit data ready for ${DEMO_EMAIL}: 2 credit notes, ${sure} suggested sure pairs, 3 free bank rows`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
