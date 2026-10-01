import { parseReceiptAmount } from "./receipt-vat";
import { isStrictIsoDate } from "./validation";

export interface ReceiptFieldInput {
  vendor: string;
  date: string;
  totalAmount: string;
  category: string;
  reference?: string;
  invoiceNumber?: string;
  notes?: string;
}

/** The same limits the server enforces (PATCH /api/receipts/[id]). */
export const RECEIPT_LIMITS = { vendor: 300, reference: 40, invoiceNumber: 40, notes: 500 } as const;

/** Field errors for the receipt editor, in screen order. */
export function validateReceiptFields(input: ReceiptFieldInput): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!input.vendor.trim()) errors.vendor = "Myyjä on pakollinen.";
  if (!isStrictIsoDate(input.date)) errors.date = "Valitse päivämäärä.";
  const amount = parseReceiptAmount(input.totalAmount);
  if (!input.totalAmount.trim()) {
    errors.totalAmount = "Summa on pakollinen.";
  } else if (amount === null) {
    errors.totalAmount = "Summa ei ole kelvollinen.";
  } else if (amount <= 0) {
    errors.totalAmount = "Summan pitää olla suurempi kuin nolla.";
  }
  if (!input.category.trim()) errors.category = "Valitse kategoria.";
  if (input.vendor.trim().length > RECEIPT_LIMITS.vendor) {
    errors.vendor = `Myyjä saa olla enintään ${RECEIPT_LIMITS.vendor} merkkiä.`;
  }
  if ((input.reference ?? "").trim().length > RECEIPT_LIMITS.reference) {
    errors.reference = `Viitenumero saa olla enintään ${RECEIPT_LIMITS.reference} merkkiä.`;
  }
  if ((input.invoiceNumber ?? "").trim().length > RECEIPT_LIMITS.invoiceNumber) {
    errors.invoiceNumber = `Laskun numero saa olla enintään ${RECEIPT_LIMITS.invoiceNumber} merkkiä.`;
  }
  if ((input.notes ?? "").trim().length > RECEIPT_LIMITS.notes) {
    errors.notes = `Selite saa olla enintään ${RECEIPT_LIMITS.notes} merkkiä.`;
  }
  return errors;
}

export function receiptFieldId(key: string): string {
  if (key === "vendor") return "receipt-vendor";
  if (key === "date") return "receipt-date";
  if (key === "totalAmount") return "receipt-total";
  if (key === "category") return "receipt-category";
  if (key === "reference") return "receipt-reference";
  if (key === "invoiceNumber") return "receipt-invoice-number";
  if (key === "notes") return "receipt-notes";
  return key;
}

/**
 * The element that takes focus when the category is the first invalid field.
 * While no category is chosen the control is a chip group, which has its own id
 * so the refusal is scrolled to and focused instead of staying off screen (V12).
 */
export function receiptCategoryFocusId(state: { useCustom: boolean; hasCategory: boolean }): string {
  if (state.useCustom) return "receipt-custom-category";
  return state.hasCategory ? "receipt-category" : "receipt-category-group";
}
