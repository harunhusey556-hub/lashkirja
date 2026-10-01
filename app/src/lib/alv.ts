import { RATE_TO_FIELD } from "@/lib/vero/omavero-fields";
import { eurosToCents, centsToEuros } from "./money";

export interface ReceiptLike {
  type: string; // "tulo" | "meno"
  totalAmount: number | null;
  vatDetails: string | null; // JSON: [{ rate, amount }] where amount = VAT in euros
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
}

export interface AlvReport {
  field301: SalesField; // 25,5 % (legacy 24 %)
  field302: SalesField; // 13,5 % (legacy 14 %)
  field303: SalesField; // 10 %
  field309: { turnover: number }; // 0 % turnover
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

  for (const r of receipts) {
    if (r.type !== "tulo" && r.type !== "meno") continue;
    const grossCents = (r.totalAmount == null) ? 0 : eurosToCents(r.totalAmount);
    const lines = parseVatDetails(r.vatDetails);

    if (r.type === "meno") {
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
  for (const purchase of purchaseInvoices) purchaseInvoiceVatCents += purchase.vatCents;
  deductibleVatCents += purchaseInvoiceVatCents;

  // Check #1924: 308 = (301+302+303+304+305+306+318) − 307; EU fields are 0 here
  const totalSalesVatCents = salesCents[301].vat + salesCents[302].vat + salesCents[303].vat;
  const payableCents = totalSalesVatCents - deductibleVatCents;

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
    },
  };
}
