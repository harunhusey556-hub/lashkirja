/**
 * Rules of the seller details form that do not need the screen: what counts as
 * a change, what may not be blanked, and what a save may honestly say (F23).
 */

export interface SellerFormValues {
  businessName: string;
  businessId: string;
  addressStreet: string;
  addressPostalCode: string;
  addressCity: string;
  phone: string;
  invoiceIban: string;
  invoiceBic: string;
  invoiceTerms: string;
  lateInterestPercent: string;
  reminderFeeCents: string;
}

function comparable(key: keyof SellerFormValues, value: string): string {
  const trimmed = value.trim();
  return key === "invoiceIban" ? trimmed.replace(/\s+/g, "").toUpperCase() : trimmed;
}

/** True when the form holds exactly what is already saved. */
export function sellerUnchanged(values: SellerFormValues, baseline: SellerFormValues): boolean {
  return (Object.keys(values) as Array<keyof SellerFormValues>).every(
    (key) => comparable(key, values[key]) === comparable(key, baseline[key])
  );
}

const REQUIRED_ONCE_SET: Array<[keyof SellerFormValues, string]> = [
  ["businessName", "Anna nimi. Laskulla pitää olla myyjän nimi."],
  ["businessId", "Anna Y-tunnus. Laskulla pitää olla myyjän Y-tunnus."],
  ["invoiceIban", "Anna tilinumero. Laskulla pitää olla tilinumero."],
];

/**
 * Name, Y-tunnus and IBAN make an invoice a valid one. Once saved they are not
 * blanked by accident: the field is refused with a message, not silently wiped.
 */
export function sellerBlankedErrors(values: SellerFormValues, baseline: SellerFormValues): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const [key, message] of REQUIRED_ONCE_SET) {
    if (comparable(key, baseline[key]) && !comparable(key, values[key])) errors[key] = message;
  }
  return errors;
}

/** What is still missing before an invoice can be sent (the Koti checklist's definition). */
export function sellerMissingForInvoices(values: SellerFormValues): string[] {
  const missing: string[] = [];
  if (!values.businessName.trim()) missing.push("nimi");
  if (!values.businessId.trim()) missing.push("Y-tunnus");
  if (!values.invoiceIban.trim()) missing.push("tilinumero");
  return missing;
}

/** The toast after a successful save: never claims more than is true. */
export function sellerSavedText(values: SellerFormValues): string {
  const missing = sellerMissingForInvoices(values);
  if (missing.length === 0) return "Laskuttajan tiedot tallennettu.";
  const list =
    missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(", ")} ja ${missing[missing.length - 1]}`;
  return `Tallennettu. Laskun lähettämiseen tarvitaan vielä ${list}.`;
}
