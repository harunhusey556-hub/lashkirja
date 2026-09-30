import { prisma } from "./db";
import { parseBusinessDetails, deriveVatProfile } from "./onboarding";
import { getVendorIntelligence, isAmountWithinRange } from "./vendor-intelligence";
import { computeConfidence } from "./confidence";
import { SOURCE_DRAFT_REASONS } from "./matching";

/**
 * Drafts sales receipts (myyntitositteet) for incoming bank transfers that
 * look like payment-processor settlements, for the user to review.
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

export async function autoGenerateIncomeReceipts(userId: string, statementId: string): Promise<number> {
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

  let generatedCount = 0;

  for (const tx of unmatchedIncomes) {
    try {
      if (alreadyDrafted.has(tx.id)) continue;

      const cp = tx.counterparty || "";
      const provider = SETTLEMENT_PROVIDERS.find((p) =>
        cp.toLowerCase().includes(p.needle)
      );

      let vendor = cp || "Tuntematon maksaja";
      let feePercent: number | null = 0;
      let isExactGross = true;
      let note = "Tulo (Automaattinen luonnos)";

      if (provider) {
        vendor = provider.vendor;
        feePercent = provider.feePercent;
        isExactGross = provider.isExactGross;
        note = provider.note;
      }

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
        providerRecognized: !!provider,
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
          rawText: "Luonnos tiliotteen rivistä. Ei vahvistettu tosite.",
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
