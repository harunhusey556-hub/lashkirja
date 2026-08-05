import { prisma } from "./db";

/**
 * Drafts sales receipts (myyntitositteet) for incoming bank transfers that
 * look like payment-processor settlements, for the user to review.
 *
 * Every draft is created as `pending` and is never linked to the transaction
 * automatically. Nothing here reaches the ALV report until a human approves it.
 *
 * Why this is deliberately timid: an incoming transfer is not evidence of a
 * sale. It could equally be an owner contribution, a loan, a tax refund, an
 * insurance payout, a supplier refund, or a transfer between the user's own
 * accounts. This function previously created `approved` receipts asserting a
 * flat 25.5 % VAT on *every* unmatched incoming transfer and linked them
 * immediately, so moving your own money into the business produced a VAT
 * liability on it.
 *
 * VAT is deliberately left unset. Processors settle NET of their fee, so the
 * deposit is not the gross sale and 25.5 % of it is not the VAT — gross sales,
 * the fee, and VAT on the fee all have to be recorded separately. Guessing here
 * would understate both revenue and VAT. Proper settlement handling and
 * evidence-based recognition (trusted counterparties, reference matches) belong
 * to the automation-rules work, not to a blanket rule.
 */
const SETTLEMENT_PROVIDERS: { needle: string; vendor: string; note: string }[] = [
  { needle: "mobilepay", vendor: "MobilePay Myyntitilitys", note: "MobilePay tilitys" },
  { needle: "holvi", vendor: "Holvi Myyntitilitys", note: "Holvi tilitys" },
  { needle: "zettle", vendor: "Zettle Myyntitilitys", note: "Zettle tilitys" },
  { needle: "stripe", vendor: "Stripe Myyntitilitys", note: "Stripe tilitys" },
  { needle: "sumup", vendor: "SumUp Myyntitilitys", note: "SumUp tilitys" },
];

export async function autoGenerateIncomeReceipts(userId: string, statementId: string): Promise<number> {
  const unmatchedIncomes = await prisma.transaction.findMany({
    where: {
      statementId,
      statement: { userId },
      type: "tulo",
      matchStatus: { in: ["unmatched", "suggested"] },
      receiptId: null,
    },
  });

  if (unmatchedIncomes.length === 0) return 0;

  let generatedCount = 0;

  for (const tx of unmatchedIncomes) {
    try {
      const cp = tx.counterparty || "";
      const provider = SETTLEMENT_PROVIDERS.find((p) =>
        cp.toLowerCase().includes(p.needle)
      );

      // Only recognised settlement providers get a draft. A plain incoming
      // transfer from an unknown payer carries no evidence that it is a sale,
      // so it is left unmatched for the user to classify rather than being
      // guessed at.
      if (!provider) continue;

      await prisma.receipt.create({
        data: {
          userId,
          type: "tulo",
          vendor: provider.vendor,
          date: tx.date || new Date(),
          totalAmountCents: Math.abs(tx.amountCents),
          // Unset on purpose — see the note above on net settlements.
          vatDetails: null,
          category: "myynti",
          notes: `${provider.note} — LUONNOS. Tarkista summa ja ALV ennen hyväksyntää. Tilitys voi olla nettosumma, josta palvelumaksu on jo vähennetty.`,
          reference: tx.reference,
          invoiceNumber: null,
          filePath: "auto-generated",
          fileName: "Myyntitosite_luonnos.txt",
          source: "auto_income",
          // Not 1.0: this is an unverified inference from a bank row.
          confidence: 0.3,
          rawText: "Luonnos tiliotteen rivistä. Ei vahvistettu tosite.",
          reviewStatus: "pending",
        },
      });

      // Deliberately not linked to the transaction here. The draft goes to the
      // review queue; matching happens after a human approves it.
      generatedCount++;
    } catch (error) {
      console.error(`Failed to draft income receipt for transaction ${tx.id}:`, error);
    }
  }

  return generatedCount;
}
