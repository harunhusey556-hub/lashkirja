import { z } from "zod";
import { eurosToCents } from "./money";
import type { PurchaseVatTreatment } from "./alv";
import { foreignFieldsFromExtraction } from "./foreign-purchase";

/** ISO 4217, upper case: "EUR", "USD". */
export const currencySchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{3}$/, "Valuutan on oltava kolmikirjaiminen koodi, esim. EUR tai USD."));

/**
 * The currency columns of a receipt being saved from the editor: what the
 * owner chose wins; what they did not touch comes from the reading stored on
 * the upload, so a foreign document keeps its suggested treatment.
 */
export function foreignColumns(
  body: { currency?: string; originalAmount?: number | null; vatTreatment?: PurchaseVatTreatment; type?: string; category?: string | null; vatDetails?: Array<{ rate: number; amount: number }> | null },
  extractedJson: string | null
): { currency: string; vatTreatment: PurchaseVatTreatment; originalAmountCents: number | null } {
  let read: { currency?: string | null; sellerCountry?: string | null; notes?: string | null } = {};
  try {
    read = extractedJson ? (JSON.parse(extractedJson) as typeof read) : {};
  } catch {
    // An unreadable stored reading only loses the suggestion; the owner's own fields still save.
    read = {};
  }
  const suggested = foreignFieldsFromExtraction({
    currency: body.currency ?? read.currency ?? null,
    sellerCountry: read.sellerCountry ?? null,
    notes: read.notes ?? null,
    category: body.category ?? null,
    type: body.type,
    vatDetails: body.vatDetails ?? [],
  });
  return {
    currency: body.currency ?? suggested.currency,
    vatTreatment: body.vatTreatment ?? suggested.vatTreatment,
    originalAmountCents: body.originalAmount == null ? null : eurosToCents(body.originalAmount),
  };
}
