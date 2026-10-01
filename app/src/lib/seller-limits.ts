/**
 * Maximum lengths of the seller details (Laskuttajan tiedot). One list for the
 * form's maxLength, its checks and the server's schema, so they cannot drift.
 */
export const SELLER_LIMITS = {
  businessName: 120,
  businessId: 20,
  addressStreet: 120,
  addressPostalCode: 20,
  addressCity: 80,
  phone: 40,
  invoiceIban: 42,
  invoiceBic: 11,
  invoiceTerms: 1000,
} as const;
