import { prisma } from "./db";

export interface VendorIntelligence {
  vendor: string;
  approvedCount: number;
  lastApprovedCategory: string | null;
  avgAmountCents: number;
  stdDevAmountCents: number;
  categoryConsistency: number; // 0-1
}

export async function getVendorIntelligence(
  userId: string,
  vendor: string
): Promise<VendorIntelligence | null> {
  const receipts = await prisma.receipt.findMany({
    where: {
      userId,
      vendor: vendor,
      reviewStatus: "approved",
    },
    select: {
      category: true,
      totalAmountCents: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  if (receipts.length === 0) return null;

  const validAmounts = receipts
    .map(r => r.totalAmountCents)
    .filter((a): a is number => a !== null);

  let avgAmountCents = 0;
  let stdDevAmountCents = 0;

  if (validAmounts.length > 0) {
    avgAmountCents = validAmounts.reduce((a, b) => a + b, 0) / validAmounts.length;
    if (validAmounts.length > 1) {
      const variance =
        validAmounts.reduce((a, b) => a + Math.pow(b - avgAmountCents, 2), 0) /
        (validAmounts.length - 1);
      stdDevAmountCents = Math.sqrt(variance);
    }
  }

  // Calculate category consistency
  const categoryCounts = new Map<string, number>();
  const lastApprovedCategory = receipts[0]?.category || null;

  for (const r of receipts) {
    if (r.category) {
      categoryCounts.set(r.category, (categoryCounts.get(r.category) || 0) + 1);
    }
  }

  const mostFrequentCategoryCount = Math.max(...Array.from(categoryCounts.values()), 0);
  const categoryConsistency = receipts.length > 0 ? mostFrequentCategoryCount / receipts.length : 0;

  return {
    vendor,
    approvedCount: receipts.length,
    lastApprovedCategory,
    avgAmountCents,
    stdDevAmountCents,
    categoryConsistency,
  };
}

export function isAmountWithinRange(amountCents: number, intel: VendorIntelligence | null): boolean {
  if (!intel || intel.approvedCount < 2) return true; // Not enough history to judge
  
  // If std deviation is very small (e.g. constant subscription), allow 10% variance minimum
  const minVariance = Math.max(intel.stdDevAmountCents * 2, intel.avgAmountCents * 0.1);
  
  const minExpected = intel.avgAmountCents - minVariance;
  const maxExpected = intel.avgAmountCents + minVariance;
  
  return amountCents >= minExpected && amountCents <= maxExpected;
}

/** AutomationEvent kind of a vendor name the owner corrected on a receipt (receipt-update.ts). */
export const VENDOR_CORRECTION_KIND = "vendor";
const CORRECTIONS_IN_PROMPT = 8;

/**
 * The owner's latest vendor corrections as prompt lines: a name read wrong (or not at all)
 * and what it really is. One correction is enough here - unlike a category, a name the
 * owner typed is not a guess.
 */
async function vendorCorrectionsForAiPrompt(userId: string): Promise<string> {
  const events = await prisma.automationEvent.findMany({
    where: { userId, kind: VENDOR_CORRECTION_KIND, resourceType: "receipt" },
    select: { previousValue: true, newValue: true },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const lines = new Map<string, string>();
  for (const event of events) {
    const corrected = event.newValue?.trim();
    if (!corrected) continue;
    const read = event.previousValue?.trim();
    const key = `${read?.toLowerCase() ?? ""}→${corrected.toLowerCase()}`;
    if (lines.has(key)) continue;
    lines.set(key, read ? `- luettu "${read}" → oikea myyjä ${corrected}` : `- ${corrected}`);
    if (lines.size >= CORRECTIONS_IN_PROMPT) break;
  }
  if (lines.size === 0) return "";
  return (
    `Käyttäjän korjaamat myyjät (jos dokumentti on samalta lähettäjältä, käytä korjattua nimeä):\n` +
    [...lines.values()].join("\n")
  );
}

export async function getTopVendorsForAiPrompt(userId: string): Promise<string> {
  const [categories, corrections] = await Promise.all([
    vendorCategoriesForAiPrompt(userId),
    vendorCorrectionsForAiPrompt(userId),
  ]);
  return [categories, corrections].filter(Boolean).join("\n\n");
}

async function vendorCategoriesForAiPrompt(userId: string): Promise<string> {
  const receipts = await prisma.receipt.findMany({
    where: { userId, reviewStatus: "approved" },
    select: { vendor: true, category: true },
  });

  if (receipts.length === 0) return "";

  const vendorToCatCounts = new Map<string, Map<string, number>>();
  for (const r of receipts) {
    if (!r.vendor || !r.category) continue;
    const vendorMap = vendorToCatCounts.get(r.vendor) || new Map<string, number>();
    vendorMap.set(r.category, (vendorMap.get(r.category) || 0) + 1);
    vendorToCatCounts.set(r.vendor, vendorMap);
  }

  const vendorPriors = Array.from(vendorToCatCounts.entries())
    .map(([vendor, categories]) => {
      const bestCat = Array.from(categories.entries()).sort((a, b) => b[1] - a[1])[0];
      return { vendor, category: bestCat[0], count: bestCat[1] };
    })
    .filter(v => v.count >= 2) // Require at least 2 approvals to learn
    .sort((a, b) => b.count - a.count)
    .slice(0, 8); // Send top 8

  if (vendorPriors.length === 0) return "";

  return `Aiemmin hyväksytyt (käytä näitä kategorioita näille myyjille, jos mahdollista):\n` +
    vendorPriors.map(v => `- ${v.vendor} → ${v.category}`).join("\n");
}
