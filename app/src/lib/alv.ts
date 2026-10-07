import { RATE_TO_FIELD } from "@/lib/vero/omavero-fields";
import { eurosToCents, centsToEuros } from "./money";

/**
 * How a purchase's VAT reaches the return. `domestic` reads the VAT printed on
 * the document; the reverse-charge kinds self-assess VAT on the gross (the
 * document carries none) and deduct the same amount; `foreign_vat_charged` is
 * Finnish VAT a foreign seller charged through OSS, which is not deductible.
 */
export const PURCHASE_VAT_TREATMENTS = [
  "domestic",
  "eu_service",
  "eu_goods",
  "non_eu_service",
  "non_eu_goods",
  "foreign_vat_charged",
] as const;
export type PurchaseVatTreatment = (typeof PURCHASE_VAT_TREATMENTS)[number];

export function isPurchaseVatTreatment(value: unknown): value is PurchaseVatTreatment {
  return typeof value === "string" && (PURCHASE_VAT_TREATMENTS as readonly string[]).includes(value);
}

/** The general rate rose from 24 % to 25,5 % on 1.9.2024; reverse charge uses the rate of the purchase date. */
export function reverseChargeRate(date: Date | string | null | undefined): number {
  if (!date) return 25.5;
  const iso = typeof date === "string" ? date : date.toISOString();
  return iso.slice(0, 10) < "2024-09-01" ? 24 : 25.5;
}

export interface ReceiptLike {
  type: string; // "tulo" | "meno"
  totalAmount: number | null;
  vatDetails: string | null; // JSON: [{ rate, amount }] where amount = VAT in euros
  /** Purchases only; absent means domestic. */
  vatTreatment?: string | null;
  date?: Date | string | null;
}

export interface SalesField {
  netSales: number;
  vat: number;
}

/**
 * A sales invoice reduced to what the VAT return needs. Rates are permille
 * (255 = 25,5 %) exactly as they are stored on the invoice lines.
 */
export interface InvoiceVatSource {
  breakdown: Array<{ ratePermille: number; netCents: number; vatCents: number }>;
}

/**
 * A purchase invoice reduced to what the VAT return needs: its VAT, which is
 * deductible (field 307). The loader decides which invoices count and which
 * are already counted through a receipt (lib/alv-period.ts, F39).
 */
export interface PurchaseVatSource {
  vatCents: number;
  /** Absent means domestic. Reverse charge self-assesses VAT on `grossCents`. */
  vatTreatment?: string | null;
  grossCents?: number;
  date?: Date | string | null;
}

export interface AlvReport {
  field301: SalesField; // 25,5 % (legacy 24 %)
  field302: SalesField; // 13,5 % (legacy 14 %)
  field303: SalesField; // 10 %
  field309: { turnover: number }; // 0 % turnover
  field305: { amount: number }; // Vero tavaraostoista muista EU-maista
  field306: { amount: number }; // Vero palveluostoista muista EU-maista
  field313: { amount: number }; // Tavaraostot muista EU-maista (veroton arvo)
  field314: { amount: number }; // Palveluostot muista EU-maista (veroton arvo)
  field307: { amount: number };
  field308: { amount: number; isRefund: boolean };
  /** Gross sums of receipts that had no usable VAT breakdown — need manual review. */
  review: { salesGross: number; purchasesGross: number; count: number };
  /** Where the reported sales VAT came from, so the number can be traced. */
  sources: {
    receiptSalesVat: number;
    invoiceSalesVat: number;
    invoiceCount: number;
    /** F39: deductible VAT that came from purchase invoices (included in field 307). */
    purchaseInvoiceVat: number;
    purchaseInvoiceCount: number;
    /** VAT self-assessed on reverse-charge purchases: in 301/305/306 and again in 307. */
    reverseChargeVat: number;
    /** Finnish VAT foreign sellers charged (OSS); paid but not deductible. */
    foreignVatNotDeducted: number;
  };
}

export interface VatLine {
  rate: number;
  amountCents: number;
}

/** Exported so reporting can reuse the exact same parsing the ALV return uses. */
export function parseVatDetails(raw: string | null): VatLine[] | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const lines = parsed
      .map((d) => {
        const rate = Number(d?.rate);
        const amount = Number(d?.amount);
        return { rate, amount };
      })
      .filter((d) => Number.isFinite(d.rate) && Number.isFinite(d.amount))
      .map((d) => ({ rate: d.rate, amountCents: eurosToCents(d.amount) }));
    return lines.length > 0 ? lines : null;
  } catch {
    return null;
  }
}

/**
 * Computes OmaVero ALV return fields from receipts.
 * Strictly calculates using integer cents to prevent floating point sum errors.
 * Never assumes a VAT rate: receipts without a usable breakdown go to `review`.
 */
export function computeAlvReport(
  receipts: ReceiptLike[],
  invoices: InvoiceVatSource[] = [],
  purchaseInvoices: PurchaseVatSource[] = []
): AlvReport {
  const salesCents: Record<301 | 302 | 303, { netSales: number; vat: number }> = {
    301: { netSales: 0, vat: 0 },
    302: { netSales: 0, vat: 0 },
    303: { netSales: 0, vat: 0 },
  };
  let zeroRateTurnoverCents = 0;
  let deductibleVatCents = 0;
  const review = { salesGrossCents: 0, purchasesGrossCents: 0, count: 0 };
  const eu = { goodsVat: 0, servicesVat: 0, goodsBase: 0, servicesBase: 0 };
  let reverseChargeVatCents = 0;
  let foreignVatNotDeductedCents = 0;

  /**
   * A non-domestic purchase. Returns false for `domestic` so the caller reads
   * the document's own VAT. Reverse charge: the document has no VAT, so the
   * gross is the base; the self-assessed tax is payable and deductible alike.
   */
  function addForeignPurchase(
    treatment: string | null | undefined,
    grossCents: number,
    documentVatCents: number,
    date: Date | string | null | undefined
  ): boolean {
    if (!treatment || treatment === "domestic") return false;
    if (treatment === "foreign_vat_charged") {
      foreignVatNotDeductedCents += documentVatCents;
      return true;
    }
    if (treatment === "non_eu_goods") {
      // Import VAT is levied by customs or reported by a registered importer; never guessed here.
      review.purchasesGrossCents += grossCents;
      review.count += 1;
      return true;
    }
    const baseCents = grossCents - documentVatCents;
    const taxCents = Math.round((baseCents * reverseChargeRate(date)) / 100);
    if (treatment === "eu_service") {
      eu.servicesVat += taxCents;
      eu.servicesBase += baseCents;
    } else if (treatment === "eu_goods") {
      eu.goodsVat += taxCents;
      eu.goodsBase += baseCents;
    } else if (treatment === "non_eu_service") {
      // Services from outside the EU: the tax goes with domestic sales VAT, the base is not reported.
      salesCents[RATE_TO_FIELD[reverseChargeRate(date)]].vat += taxCents;
    } else {
      review.purchasesGrossCents += grossCents;
      review.count += 1;
      return true;
    }
    reverseChargeVatCents += taxCents;
    deductibleVatCents += taxCents;
    return true;
  }

  for (const r of receipts) {
    if (r.type !== "tulo" && r.type !== "meno") continue;
    const grossCents = (r.totalAmount == null) ? 0 : eurosToCents(r.totalAmount);
    const lines = parseVatDetails(r.vatDetails);

    if (r.type === "meno") {
      const documentVatCents = lines ? lines.reduce((sum, l) => sum + l.amountCents, 0) : 0;
      if (addForeignPurchase(r.vatTreatment, grossCents, documentVatCents, r.date)) continue;
      if (lines) {
        let receiptVatCents = 0;
        for (const l of lines) receiptVatCents += l.amountCents;
        deductibleVatCents += receiptVatCents;
      } else if (grossCents > 0) {
        review.purchasesGrossCents += grossCents;
        review.count += 1;
      }
      continue;
    }

    // tulo
    const isZeroRated =
      lines != null && lines.every((l) => l.rate === 0 || l.amountCents === 0) &&
      lines.some((l) => l.rate === 0);
    
    if (isZeroRated) {
      zeroRateTurnoverCents += grossCents;
      continue;
    }
    if (!lines) {
      if (grossCents > 0) {
        review.salesGrossCents += grossCents;
        review.count += 1;
      }
      continue;
    }
    
    // Perform discrepancy checks for line items if necessary, 
    // but ultimately map strictly by parsed amounts
    let currentReceiptSalesNetCents = 0;
    
    for (const line of lines) {
      const field = RATE_TO_FIELD[line.rate];
      if (!field) {
        review.salesGrossCents += line.amountCents;
        review.count += 1;
        continue;
      }
      salesCents[field].vat += line.amountCents;
      
      const netFromVatCents = Math.round((line.amountCents * 100) / line.rate);
      salesCents[field].netSales += netFromVatCents;
      currentReceiptSalesNetCents += netFromVatCents;
    }
  }

  const receiptSalesVatCents =
    salesCents[301].vat + salesCents[302].vat + salesCents[303].vat;

  // Sales invoices carry their own VAT breakdown, so they are added directly
  // rather than being re-derived from a gross amount. Zero-rated lines are
  // turnover (field 309), not VAT.
  let invoiceSalesVatCents = 0;
  for (const invoice of invoices) {
    for (const line of invoice.breakdown) {
      const rate = line.ratePermille / 10;
      if (rate === 0) {
        zeroRateTurnoverCents += line.netCents;
        continue;
      }
      const field = RATE_TO_FIELD[rate];
      if (!field) {
        // An unmappable rate must not vanish into a total silently.
        review.salesGrossCents += line.netCents + line.vatCents;
        review.count += 1;
        continue;
      }
      salesCents[field].vat += line.vatCents;
      salesCents[field].netSales += line.netCents;
      invoiceSalesVatCents += line.vatCents;
    }
  }

  // F39: a recorded purchase invoice's VAT is deductible like a receipt's. The
  // loader (alv-period.ts) leaves out the ones a receipt already counts, so the
  // same VAT is never taken twice.
  let purchaseInvoiceVatCents = 0;
  for (const purchase of purchaseInvoices) {
    if (addForeignPurchase(purchase.vatTreatment, purchase.grossCents ?? 0, purchase.vatCents, purchase.date)) continue;
    purchaseInvoiceVatCents += purchase.vatCents;
  }
  deductibleVatCents += purchaseInvoiceVatCents;

  // Check #1924: 308 = (301+302+303+304+305+306+318) − 307; 304 and 318 are 0 here
  const totalSalesVatCents = salesCents[301].vat + salesCents[302].vat + salesCents[303].vat;
  const payableCents = totalSalesVatCents + eu.goodsVat + eu.servicesVat - deductibleVatCents;

  return {
    field301: { 
      netSales: centsToEuros(salesCents[301].netSales), 
      vat: centsToEuros(salesCents[301].vat) 
    },
    field302: { 
      netSales: centsToEuros(salesCents[302].netSales), 
      vat: centsToEuros(salesCents[302].vat) 
    },
    field303: { 
      netSales: centsToEuros(salesCents[303].netSales), 
      vat: centsToEuros(salesCents[303].vat) 
    },
    field309: { turnover: centsToEuros(zeroRateTurnoverCents) },
    field305: { amount: centsToEuros(eu.goodsVat) },
    field306: { amount: centsToEuros(eu.servicesVat) },
    field313: { amount: centsToEuros(eu.goodsBase) },
    field314: { amount: centsToEuros(eu.servicesBase) },
    field307: { amount: centsToEuros(deductibleVatCents) },
    field308: { amount: centsToEuros(Math.abs(payableCents)), isRefund: payableCents < 0 },
    review: {
      salesGross: centsToEuros(review.salesGrossCents),
      purchasesGross: centsToEuros(review.purchasesGrossCents),
      count: review.count,
    },
    sources: {
      receiptSalesVat: centsToEuros(receiptSalesVatCents),
      invoiceSalesVat: centsToEuros(invoiceSalesVatCents),
      invoiceCount: invoices.length,
      purchaseInvoiceVat: centsToEuros(purchaseInvoiceVatCents),
      purchaseInvoiceCount: purchaseInvoices.length,
      reverseChargeVat: centsToEuros(reverseChargeVatCents),
      foreignVatNotDeducted: centsToEuros(foreignVatNotDeductedCents),
    },
  };
}
