import { parseReceiptAmount } from "./receipt-vat";
import { isStrictIsoDate } from "./validation";

export interface ReceiptFieldInput {
  vendor: string;
  date: string;
  totalAmount: string;
  category: string;
}

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
  return errors;
}

export function receiptFieldId(key: string): string {
  if (key === "vendor") return "receipt-vendor";
  if (key === "date") return "receipt-date";
  if (key === "totalAmount") return "receipt-total";
  if (key === "category") return "receipt-category";
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
