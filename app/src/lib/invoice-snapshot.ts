/**
 * Seller and customer fields printed on a sales-invoice PDF.
 *
 * Drafts read the live profile. The moment an invoice is issued or emailed,
 * these fields are stored with it. A later edit to the company profile or the
 * customer register must not change a document the customer already holds.
 */
import type { InvoicePdfCustomer, InvoicePdfSeller } from "./invoice-pdf";

export interface InvoicePartySnapshot {
  v: 1;
  capturedAt: string;
  seller: InvoicePdfSeller;
  customer: InvoicePdfCustomer;
}

export interface SellerSource {
  firstName: string;
  lastName: string;
  businessName?: string | null;
  businessId?: string | null;
  addressStreet?: string | null;
  addressPostalCode?: string | null;
  addressCity?: string | null;
  email?: string | null;
  phone?: string | null;
  invoiceIban?: string | null;
  invoiceBic?: string | null;
  invoiceTerms?: string | null;
  vatRegistered: boolean;
}

export interface CustomerSource {
  name: string;
  businessId?: string | null;
  email?: string | null;
  addressStreet?: string | null;
  addressPostalCode?: string | null;
  addressCity?: string | null;
}

/** Fields that must exist before an invoice may be emailed. */
export function missingSellerSendFields(seller: InvoicePdfSeller): string[] {
  const missing: string[] = [];
  if (!seller.name.trim()) missing.push("nimi");
  if (!seller.iban?.trim()) missing.push("tilinumero");
  return missing;
}

export function sellerFromUser(user: SellerSource): InvoicePdfSeller {
  const person = `${user.firstName} ${user.lastName}`.trim();
  return {
    name: user.businessName?.trim() || person,
    businessId: user.businessId,
    addressStreet: user.addressStreet,
    addressPostalCode: user.addressPostalCode,
    addressCity: user.addressCity,
    email: user.email,
    phone: user.phone,
    iban: user.invoiceIban,
    bic: user.invoiceBic,
    terms: user.invoiceTerms,
    vatRegistered: user.vatRegistered,
  };
}

export function customerFromCustomer(customer: CustomerSource): InvoicePdfCustomer {
  return {
    name: customer.name,
    businessId: customer.businessId,
    email: customer.email,
    addressStreet: customer.addressStreet,
    addressPostalCode: customer.addressPostalCode,
    addressCity: customer.addressCity,
  };
}

export function serializePartySnapshot(
  seller: InvoicePdfSeller,
  customer: InvoicePdfCustomer,
  capturedAt: string = new Date().toISOString()
): string {
  const snapshot: InvoicePartySnapshot = { v: 1, capturedAt, seller, customer };
  return JSON.stringify(snapshot);
}

export function parsePartySnapshot(raw: string | null | undefined): InvoicePartySnapshot | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<InvoicePartySnapshot>;
    if (parsed.v !== 1 || !parsed.seller?.name || !parsed.customer?.name) return null;
    return parsed as InvoicePartySnapshot;
  } catch {
    return null;
  }
}
