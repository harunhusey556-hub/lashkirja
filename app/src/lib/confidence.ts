export interface ConfidenceSignals {
  providerRecognized: boolean;         // +0.15 — known settlement provider
  singleVatProfile: boolean;           // +0.10 — quiz confirms single rate
  isExactGross: boolean;               // +0.15 — 0% fee, net = gross (e.g. MobilePay)
  feeReverseCalculated: boolean;       // +0.10 — we could estimate gross
  vendorHistoryCount: number;          // +0.01 per approval, max +0.20
  vendorCategoryConsistent: boolean;   // +0.10 — same category every time
  amountWithinRange: boolean;          // +0.05 — within 2σ of vendor average
  referenceFormatValid: boolean;       // +0.05 — matches Finnish viite format
  dateAlignedWithCycle: boolean;       // +0.05 — settlement date makes sense
}

export function computeConfidence(signals: ConfidenceSignals): number {
  let score = 0.15; // Base score — we know it's a bank row

  if (signals.providerRecognized) score += 0.15;
  if (signals.singleVatProfile) score += 0.10;
  
  if (signals.isExactGross) {
    score += 0.15;
  } else if (signals.feeReverseCalculated) {
    score += 0.10;
  }

  // History adds up to 0.20
  const historyBoost = Math.min(0.20, (signals.vendorHistoryCount || 0) * 0.02);
  score += historyBoost;

  if (signals.vendorCategoryConsistent) score += 0.10;
  if (signals.amountWithinRange) score += 0.05;
  if (signals.referenceFormatValid) score += 0.05;
  if (signals.dateAlignedWithCycle) score += 0.05;

  return Math.min(0.95, Math.round(score * 100) / 100);
}
