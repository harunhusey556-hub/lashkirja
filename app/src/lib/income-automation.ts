import { prisma } from "./db";
import { confirmMatch } from "./matching";

/**
 * Automates the creation and linking of Sales Receipts (Myyntitositteet)
 * for incoming bank transfers (tulo) that don't have a matching receipt.
 * This solves the issue of payment processors like MobilePay/Holvi
 * sending lump sums with empty messages.
 */
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
      // 1. Smart Fallback Logic for the vendor/description
      const cp = tx.counterparty || "Tuntematon maksaja";
      let generatedVendor = cp;
      let notes = tx.message || tx.reference || "Automaattisesti luotu myyntitosite pankkitapahtumasta.";

      const lowerCp = cp.toLowerCase();
      if (lowerCp.includes("mobilepay")) {
        generatedVendor = "MobilePay Myyntitilitys";
        notes = "MobilePay tilitys";
      } else if (lowerCp.includes("holvi")) {
        generatedVendor = "Holvi Myyntitilitys";
        notes = "Holvi tilitys";
      } else if (lowerCp.includes("zettle")) {
        generatedVendor = "Zettle Myyntitilitys";
        notes = "Zettle tilitys";
      } else if (lowerCp.includes("stripe")) {
        generatedVendor = "Stripe Myyntitilitys";
        notes = "Stripe tilitys";
      } else if (lowerCp.includes("sumup")) {
        generatedVendor = "SumUp Myyntitilitys";
        notes = "SumUp tilitys";
      }

      // 2. Standard 25.5% VAT calculation
      const amountEuros = Math.abs(tx.amountCents) / 100;
      // Formula to extract VAT from gross: Gross - (Gross / 1.255)
      const vatAmountEuros = amountEuros - (amountEuros / 1.255);
      
      const vatDetailsJson = JSON.stringify([
        {
          rate: 25.5,
          amount: Math.round(vatAmountEuros * 100) / 100
        }
      ]);

      // 3. Create the Receipt
      const receipt = await prisma.receipt.create({
        data: {
          userId,
          type: "tulo",
          vendor: generatedVendor,
          date: tx.date || new Date(),
          totalAmountCents: Math.abs(tx.amountCents),
          vatDetails: vatDetailsJson,
          category: "myynti",
          notes,
          reference: tx.reference,
          invoiceNumber: null,
          filePath: "auto-generated",
          fileName: "Automaattinen_Myyntitosite.txt",
          source: "auto_income",
          confidence: 1.0,
          rawText: "Automaattisesti generoitu myyntitosite tiliotteen rivistä.",
          reviewStatus: "approved",
        }
      });

      // 4. Instantly Link it to the transaction
      await confirmMatch(userId, tx.id, receipt.id, false);
      generatedCount++;

    } catch (error) {
      console.error(`Failed to auto-generate income receipt for transaction ${tx.id}:`, error);
    }
  }

  return generatedCount;
}
