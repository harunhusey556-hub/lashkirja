/**
 * F22: what the owner is told on "Uusi lasku" before the invoice exists, so the
 * blocker the send sheet would name later is known (and fixable) first.
 *
 * The send gate (invoice-snapshot.ts missingSellerSendFields) needs a seller
 * name, which falls back to the person's own name, and an IBAN. In practice only
 * the IBAN can be missing. A profile loaded from an older cache has no
 * `invoiceIban` key at all: that is "not known", never "missing".
 */
export interface SellerPreflight {
  title: string;
  body: string;
}

export function sellerPreflight(profile: { invoiceIban?: string | null } | null | undefined): SellerPreflight | null {
  if (!profile || profile.invoiceIban === undefined) return null;
  if (profile.invoiceIban?.trim()) return null;
  return {
    title: "Täydennä laskuttajan tiedot",
    body: "Laskun voi luoda nyt, mutta sen lähettämiseen tarvitaan tilinumero. Lisää se ennen ensimmäistä lähetystä.",
  };
}
