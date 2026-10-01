import { prisma } from "./db";
import { parseBusinessDetails, deriveVatProfile } from "./onboarding";
import { getVendorIntelligence, isAmountWithinRange } from "./vendor-intelligence";
import { computeConfidence } from "./confidence";
import { SOURCE_DRAFT_REASONS } from "./matching";
import type { Prisma } from "@/generated/prisma/client";

/**
 * Drafts sales receipts (myyntitositteet) for incoming bank transfers that
 * look like payment-processor settlements, for the user to review. Only a
 * settlement of a known provider is a recognised sale: any other incoming money
 * (a customer paying an invoice, a loan, the owner's own deposit, a refund) is
 * left as a plain row, because calling it a sale would be a claim nobody made.
 * A customer's invoice payment is settled against the invoice itself, so a
 * second sale document made from the same row would count the sale twice.
 *
 * Every draft is created as `pending` and is never linked to the transaction
 * automatically: it is only *suggested* on its own row, where one "Hyväksy"
 * links and approves it. Nothing here reaches the ALV report until then.
 *
 * Why this is deliberately timid: an incoming transfer is not evidence of a
 * sale. It could equally be an owner contribution, a loan, a tax refund, an
 * insurance payout, a supplier refund, or a transfer between the user's own
 * accounts.
 *
 * NEW: With the safe-by-default onboarding logic, if a user has a single VAT rate,
 * we PRE-FILL the VAT breakdown and bump the confidence to 0.7, but keep it PENDING.
 * This makes review a 1-tap operation without risking automated tax errors on net settlements.
 */
interface SettlementProvider {
  needle: string;
  vendor: string;
  note: string;
  feePercent: number | null; // null for batched providers where we can't reverse-calculate
  isExactGross: boolean;
}

const SETTLEMENT_PROVIDERS: SettlementProvider[] = [
  { needle: "mobilepay", vendor: "MobilePay Myyntitilitys", note: "MobilePay tilitys", feePercent: 0, isExactGross: true },
  { needle: "holvi", vendor: "Holvi Myyntitilitys", note: "Holvi tilitys", feePercent: null, isExactGross: false },
  { needle: "zettle", vendor: "Zettle Myyntitilitys", note: "Zettle tilitys", feePercent: 1.85, isExactGross: false },
  { needle: "stripe", vendor: "Stripe Myyntitilitys", note: "Stripe tilitys", feePercent: null, isExactGross: false },
  { needle: "sumup", vendor: "SumUp Myyntitilitys", note: "SumUp tilitys", feePercent: 1.69, isExactGross: false },
];

/** The note an older version put on a draft it made for an unknown payer. */
const UNKNOWN_PAYER_NOTE = "Tulo (Automaattinen luonnos)";

/**
 * The owner deleted a sale draft: remember it on the bank row, so the row does
 * not qualify for a new draft the next time drafting runs. Called in the same
 * transaction that deletes the draft.
 */
export async function dismissIncomeDraft(
  db: Prisma.TransactionClient,
  userId: string,
  receipt: { source: string | null; sourceTransactionId: string | null }
): Promise<void> {
  if (receipt.source !== "auto_income" || !receipt.sourceTransactionId) return;
  const row = await db.transaction.findFirst({
    where: { id: receipt.sourceTransactionId, statement: { userId } },
    select: { id: true },
  });
  if (!row) return;
  await db.incomeDraftDismissal.upsert({
    where: { transactionId: row.id },
    create: { transactionId: row.id },
    update: {},
  });
}

/**
 * A legacy draft is only "untouched" when it still equals what the old
 * generation wrote for its bank row AND was never saved after it was made. The
 * automatic note is not evidence: an owner who edits category, VAT, amount or
 * type keeps the note, so the note only says where the draft came from.
 */
const UNTOUCHED_SAVE_TOLERANCE_MS = 2000;

function isUntouchedLegacyDraft(
  draft: {
    vendor: string | null;
    type: string;
    category: string | null;
    date: Date | null;
    totalAmountCents: number | null;
    vatDetails: string | null;
    reference: string | null;
    invoiceNumber: string | null;
    createdAt: Date;
    updatedAt: Date;
  },
  row: { counterparty: string | null; amountCents: number; date: Date | null; reference: string | null }
): boolean {
  if (Math.abs(draft.updatedAt.getTime() - draft.createdAt.getTime()) > UNTOUCHED_SAVE_TOLERANCE_MS) return false;
  const grossCents = Math.abs(row.amountCents);
  if (draft.type !== "tulo" || draft.category !== "myynti") return false;
  if (draft.vendor !== (row.counterparty || "Tuntematon maksaja")) return false;
  if (draft.totalAmountCents !== grossCents) return false;
  if (draft.invoiceNumber != null) return false;
  if ((draft.reference ?? null) !== (row.reference ?? null)) return false;
  const expectedDate = row.date ?? draft.createdAt;
  const dateTolerance = row.date ? 0 : 60_000;
  if (!draft.date || Math.abs(draft.date.getTime() - expectedDate.getTime()) > dateTolerance) return false;
  if (draft.vatDetails == null) return true;
  // The generation wrote a single rate with the VAT worked out from the gross.
  try {
    const parsed: unknown = JSON.parse(draft.vatDetails);
    if (!Array.isArray(parsed) || parsed.length !== 1) return false;
    const { rate, amount } = parsed[0] as { rate?: unknown; amount?: unknown };
    if (typeof rate !== "number" || typeof amount !== "number") return false;
    return Math.round(amount * 100) === Math.round((grossCents * rate) / (100 + rate));
  } catch {
    return false;
  }
}

/**
 * Earlier versions drafted a "sale" for every incoming row. A draft of an
 * unknown payer that is provably untouched (see isUntouchedLegacyDraft) is
 * taken back, and its row is a plain row again. Anything the owner has changed
 * is theirs and stays, whatever its note says.
 */
async function takeBackUnknownPayerDrafts(userId: string, statementId: string): Promise<void> {
  const rows = await prisma.transaction.findMany({
    where: { statementId, statement: { userId } },
    select: { id: true, counterparty: true, amountCents: true, date: true, reference: true },
  });
  if (rows.length === 0) return;
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const candidates = await prisma.receipt.findMany({
    where: {
      userId,
      source: "auto_income",
      reviewStatus: "pending",
      notes: { startsWith: UNKNOWN_PAYER_NOTE },
      sourceTransactionId: { in: rows.map((row) => row.id) },
    },
  });
  const stale = candidates.filter((draft) => {
    const row = draft.sourceTransactionId ? rowById.get(draft.sourceTransactionId) : undefined;
    return row ? isUntouchedLegacyDraft(draft, row) : false;
  });
  if (stale.length === 0) return;
  const ids = stale.map((draft) => draft.id);
  await prisma.$transaction(async (db) => {
    await db.transaction.updateMany({
      where: { statement: { userId }, OR: [{ receiptId: { in: ids } }, { suggestedReceiptId: { in: ids } }] },
      data: { receiptId: null, suggestedReceiptId: null, matchStatus: "unmatched", matchScore: null, matchReasons: null },
    });
    await db.receipt.deleteMany({ where: { id: { in: ids }, userId } });
  });
}

export async function autoGenerateIncomeReceipts(userId: string, statementId: string): Promise<number> {
  await takeBackUnknownPayerDrafts(userId, statementId);
  const unmatchedIncomes = await prisma.transaction.findMany({
    where: {
      statementId,
      statement: { userId },
      type: "tulo",
      // A row already suggested to a real document does not need a draft.
      matchStatus: "unmatched",
      receiptId: null,
    },
  });

  if (unmatchedIncomes.length === 0) return 0;

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { businessDetails: true } });
  const profile = parseBusinessDetails(user?.businessDetails);
  const vatProfile = deriveVatProfile(profile);

  // Drafts are intentionally not linked to their transaction, so the
  // "unmatched" filter above keeps returning the same rows on every run. Without
  // this check each run drafted another copy — one upload plus two matching runs
  // produced 54 drafts for 18 transactions. sourceTransactionId is unique, so
  // the database is the real guard; this just avoids pointless write attempts.
  const alreadyDrafted = new Set(
    (
      await prisma.receipt.findMany({
        where: {
          userId,
          sourceTransactionId: { in: unmatchedIncomes.map((t) => t.id) },
        },
        select: { sourceTransactionId: true },
      })
    ).flatMap((r) => (r.sourceTransactionId ? [r.sourceTransactionId] : []))
  );
  // A draft the owner deleted is not made again.
  for (const dismissed of await prisma.incomeDraftDismissal.findMany({
    where: { transactionId: { in: unmatchedIncomes.map((t) => t.id) } },
    select: { transactionId: true },
  })) {
    alreadyDrafted.add(dismissed.transactionId);
  }

  let generatedCount = 0;

  for (const tx of unmatchedIncomes) {
    try {
      if (alreadyDrafted.has(tx.id)) continue;

      const cp = tx.counterparty || "";
      const provider = SETTLEMENT_PROVIDERS.find((p) =>
        cp.toLowerCase().includes(p.needle)
      );

      // Not a settlement of a known provider: a plain income row, not a sale.
      if (!provider) continue;
      const vendor = provider.vendor;
      const feePercent = provider.feePercent;
      const isExactGross = provider.isExactGross;
      const note = provider.note;

      const netCents = Math.abs(tx.amountCents);
      let grossCents = netCents;
      let feeReverseCalculated = false;

      if (feePercent != null && feePercent > 0) {
        grossCents = Math.round(netCents / (1 - feePercent / 100));
        feeReverseCalculated = true;
      }

      let vatDetailsJson: string | null = null;
      let notes = `${note} — LUONNOS. Tarkista summa ja ALV ennen hyväksyntää. Tilitys voi olla nettosumma, josta palvelumaksu on jo vähennetty.`;

      if (vatProfile.isSingleRate) {
        const rate = vatProfile.defaultSalesRate;
        const vatAmountCents = Math.round((grossCents * rate) / (100 + rate));
        vatDetailsJson = JSON.stringify([{ rate, amount: vatAmountCents / 100 }]);

        if (isExactGross) {
          notes = `${note}. ALV on täsmällinen, olettaen kyseessä olevan bruttosumma ilman vähennettävää komissiota.`;
        } else if (feeReverseCalculated) {
          notes = `${note}. Bruttomyynti (${(grossCents / 100).toFixed(2).replace('.', ',')} €) arvioitu nettotilityksestä käyttäen ${feePercent}% oletuskulua. Tarkista!`;
        } else {
          notes = `${note}. ALV laskettu suoraan tilityksestä. Tarkista, että summa vastaa todellista bruttomyyntiä.`;
        }
      }

      const intel = await getVendorIntelligence(userId, vendor);
      
      const referenceFormatValid = !!tx.reference && (tx.reference.length >= 2);
      
      // Compute dynamic confidence
      const confidence = computeConfidence({
        providerRecognized: true,
        singleVatProfile: vatProfile.isSingleRate,
        isExactGross,
        feeReverseCalculated,
        vendorHistoryCount: intel?.approvedCount || 0,
        vendorCategoryConsistent: intel ? intel.categoryConsistency >= 0.8 : false,
        amountWithinRange: isAmountWithinRange(netCents, intel),
        referenceFormatValid,
        dateAlignedWithCycle: true, // we assume it is since it's a bank tx
      });

      const draft = await prisma.receipt.create({
        data: {
          userId,
          type: "tulo",
          vendor: vendor,
          date: tx.date || new Date(),
          totalAmountCents: grossCents,
          vatDetails: vatDetailsJson,
          category: "myynti",
          notes: notes,
          reference: tx.reference,
          invoiceNumber: null,
          filePath: "auto-generated",
          fileName: "Myyntitosite_luonnos.txt",
          source: "auto_income",
          sourceTransactionId: tx.id,
          confidence,
          rawText: "Luonnos tiliotteen rivistä. Ei vahvistettu kuitti.",
          reviewStatus: "pending",
        },
      });

      // Offer the draft on its own row right away, as the one suggestion with
      // a single "Hyväksy". Matching runs before drafting, so without this the
      // row stayed "unmatched" until some later matching run.
      await prisma.transaction.updateMany({
        where: { id: tx.id, matchStatus: "unmatched", receiptId: null },
        data: {
          matchStatus: "suggested",
          suggestedReceiptId: draft.id,
          matchScore: 1,
          matchReasons: JSON.stringify(SOURCE_DRAFT_REASONS),
        },
      });

      generatedCount++;
    } catch (error) {
      console.error(`Failed to draft income receipt for transaction ${tx.id}:`, error);
    }
  }

  return generatedCount;
}
