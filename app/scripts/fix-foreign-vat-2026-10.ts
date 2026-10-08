/**
 * One-off data fix (2026-10): foreign purchases and the Svea collection demand.
 *
 *   npx tsx scripts/fix-foreign-vat-2026-10.ts            # dry run: prints every change
 *   npx tsx scripts/fix-foreign-vat-2026-10.ts --apply    # writes, and a revert file
 *
 * Run with DATABASE_URL pointing at the database (production:
 * file:C:/LashKirja/data/prod.db) after scripts/ops/backup-local.ps1.
 * Each record is picked by id and changed only if it still holds the value
 * this script was written against, so a record edited since is left alone.
 * The revert file holds every previous value (`--revert <file>` puts them back).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { prisma } from "../src/lib/db";

type Fields = Partial<{
  totalAmountCents: number | null;
  vatDetails: string | null;
  currency: string;
  originalAmountCents: number | null;
  vatTreatment: string;
  reviewStatus: string;
  notes: string | null;
}>;

interface Fix {
  id: string;
  why: string;
  /** What the record must still hold for the fix to apply. */
  expect: Fields;
  set: Fields;
}

const ZERO_VAT = '[{"rate":0,"amount":0}]';

const FIXES: Fix[] = [
  {
    id: "d8f52b70-dfb9-45c3-b10a-6a3833246d59",
    why: "Svea: only interest 19,01 € + fee 6,00 € was paid (bank −25,01 €); the principal was paid/booked separately",
    expect: { totalAmountCents: 154_647 },
    set: {
      totalAmountCents: 2_501,
      vatDetails: ZERO_VAT,
      notes:
        "Viivästyskorko 19,01 € + perintäkulu 6,00 €. Pääoma on maksettu ja kirjattu erikseen. Ei ALV-vähennyskelpoinen.",
    },
  },
  ...["bca6b1fa-fa45-4b9a-b522-088a55a6294a", "f2e64e87-0123-43c3-8246-79dfd5efb501"].map(
    (id): Fix => ({
      id,
      why: "OpenCode (USA): no Finnish VAT to deduct; reverse charge on a non-EU service",
      expect: { vatTreatment: "domestic" },
      set: { currency: "USD", vatTreatment: "non_eu_service", vatDetails: ZERO_VAT },
    })
  ),
  {
    id: "2093ecb2-5bf6-4de5-9ac5-bbb061fbcb0a",
    why: "OpenRouter (USA): a 25,5 % deduction was guessed; reverse charge on a non-EU service",
    expect: { vatTreatment: "domestic" },
    set: { currency: "USD", vatTreatment: "non_eu_service", vatDetails: ZERO_VAT },
  },
  ...[
    "4848f62e-d68c-4e14-8060-521f835036c4",
    "64500c79-a64d-48ee-9aea-4e662d1d3180",
    "06416985-dd18-444d-8201-bd987804363f",
    "2310301c-4cf4-4e08-b64b-7f5ee3a1a7d3",
  ].map(
    (id): Fix => ({
      id,
      why: "OpenRouter / Moonshot (outside the EU): reverse charge on a non-EU service",
      expect: { vatTreatment: "domestic" },
      set: { vatTreatment: "non_eu_service" },
    })
  ),
  {
    id: "681b951d-0f06-47c8-b992-6b9c822872e4",
    why: "Shopify International (IE): EU service, reverse charge; billed 352,97 USD",
    expect: { vatTreatment: "domestic" },
    set: { vatTreatment: "eu_service", currency: "USD", originalAmountCents: 35_297 },
  },
  ...[
    "54977b1f-530a-44db-b259-d77ff612080f",
    "c4676b11-3aa6-438b-b7f6-74e6c9186af4",
    "3f239015-2eeb-4af7-8520-f214214228fc",
  ].map(
    (id): Fix => ({
      id,
      why: "Anthropic: the invoice says \"VAT – Finland 25.5 %\" (OSS); that VAT is not deductible",
      expect: { vatTreatment: "domestic" },
      set: { vatTreatment: "foreign_vat_charged" },
    })
  ),
  ...[
    ["ed3e8057-0419-457a-9d2f-425c89e166cd", "8JOO0FMM0001"],
    ["0646a325-15fb-4220-a9c4-97d2d71cb5b2", "8JOO0FMM0002"],
    ["e52602be-0e59-4f23-a6b8-ea6b937fe765", "9BF0758D6943367"],
  ].map(
    ([id, invoice]): Fix => ({
      id,
      why: `Anthropic: the payment receipt PDF of invoice ${invoice}, imported from the same email as the invoice — counted twice`,
      expect: { reviewStatus: "approved" },
      set: {
        reviewStatus: "rejected",
        vatTreatment: "foreign_vat_charged",
        notes: `Kaksoiskappale: sama osto kuin lasku ${invoice} (samasta sähköpostista). Ei kirjata toiseen kertaan.`,
      },
    })
  ),
];

const FIELDS = ["totalAmountCents", "vatDetails", "currency", "originalAmountCents", "vatTreatment", "reviewStatus", "notes"] as const;

async function revert(file: string) {
  const saved = JSON.parse(readFileSync(file, "utf8")) as Array<{ id: string; before: Fields }>;
  for (const row of saved) {
    await prisma.receipt.update({ where: { id: row.id }, data: row.before });
    console.log(`reverted ${row.id}`);
  }
}

async function main() {
  const revertIndex = process.argv.indexOf("--revert");
  if (revertIndex >= 0) return revert(process.argv[revertIndex + 1]);
  const apply = process.argv.includes("--apply");
  const undo: Array<{ id: string; before: Fields }> = [];

  for (const fix of FIXES) {
    const row = await prisma.receipt.findUnique({ where: { id: fix.id } });
    if (!row) {
      console.log(`SKIP ${fix.id}: not found`);
      continue;
    }
    const drifted = Object.entries(fix.expect).filter(([key, value]) => row[key as keyof typeof row] !== value);
    if (drifted.length > 0) {
      console.log(`SKIP ${fix.id} (${row.vendor}): changed since — ${drifted.map(([key]) => key).join(", ")}`);
      continue;
    }
    const before: Fields = {};
    for (const key of FIELDS) if (key in fix.set) (before as Record<string, unknown>)[key] = row[key];
    console.log(`\n${row.vendor} ${row.date?.toISOString().slice(0, 10)} ${fix.id}\n  ${fix.why}`);
    for (const key of Object.keys(fix.set) as Array<keyof Fields>) {
      console.log(`  ${key}: ${JSON.stringify(before[key])} → ${JSON.stringify(fix.set[key])}`);
    }
    undo.push({ id: fix.id, before });
    if (apply) {
      await prisma.$transaction([
        prisma.receipt.update({ where: { id: fix.id }, data: fix.set }),
        prisma.automationEvent.create({
          data: {
            userId: row.userId,
            kind: "data_fix",
            resourceType: "receipt",
            resourceId: fix.id,
            previousValue: JSON.stringify(before),
            newValue: JSON.stringify(fix.set),
            reason: `korjaus 2026-10: ${fix.why}`.slice(0, 500),
          },
        }),
      ]);
    }
  }

  if (apply) {
    const file = `fix-foreign-vat-2026-10.revert-${Date.now()}.json`;
    writeFileSync(file, JSON.stringify(undo, null, 2));
    console.log(`\nApplied ${undo.length} changes. Revert: npx tsx scripts/fix-foreign-vat-2026-10.ts --revert ${file}`);
  } else {
    console.log(`\nDry run: ${undo.length} changes. Nothing written; add --apply.`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
