import type { PurchaseVatTreatment } from "./alv";

/**
 * The VAT treatment a purchase document suggests, from what the AI read:
 * the seller's country, the currency and any Finnish VAT a foreign seller
 * charged. A suggestion only — the receipt still waits for the owner's review
 * and the form lets them change it (lib/alv.ts decides what each means).
 */

const EU = new Set([
  "AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "ES", "FR", "GR", "EL", "HR", "HU", "IE",
  "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK",
]);

/** Categories bought as goods; everything else from abroad is taken as a service. */
const GOODS_CATEGORIES = new Set(["tarvikkeet", "polttoaine"]);

export interface ForeignPurchaseInput {
  currency?: string | null;
  sellerCountry?: string | null;
  category?: string | null;
  notes?: string | null;
  vatDetails: Array<{ rate: number; amount: number }>;
  type?: string;
  /** The total the document printed, in `currency`, exactly as read (no FX rate is ever guessed). */
  originalAmount?: number | null;
}

export function suggestPurchaseVatTreatment(input: ForeignPurchaseInput): PurchaseVatTreatment {
  if (input.type === "tulo") return "domestic";
  const country = input.sellerCountry?.toUpperCase() ?? null;
  const foreignCurrency = input.currency != null && input.currency !== "EUR";
  if ((country == null || country === "FI") && !foreignCurrency) return "domestic";
  if (country === "FI") return "domestic";

  const finnishVatOnIt = input.vatDetails.some((line) => (line.rate === 25.5 || line.rate === 24) && line.amount > 0);
  if (finnishVatOnIt || /veloitti Suomen ALV/i.test(input.notes ?? "")) return "foreign_vat_charged";

  const goods = GOODS_CATEGORIES.has(input.category ?? "");
  // A foreign currency with no country named is most often a non-EU online service.
  const inEu = country != null && EU.has(country);
  if (inEu) return goods ? "eu_goods" : "eu_service";
  return goods ? "non_eu_goods" : "non_eu_service";
}

/**
 * The receipt columns for a reading: currency (EUR when unknown), the suggested
 * treatment, and the original amount for a document that is not in euros - the
 * VAT return needs the euro figure, but the document's own total must survive
 * too or the owner has no record of what the bill actually said.
 */
export function foreignFieldsFromExtraction(input: ForeignPurchaseInput): {
  currency: string;
  vatTreatment: PurchaseVatTreatment;
  originalAmountCents: number | null;
} {
  const currency = input.currency && /^[A-Z]{3}$/.test(input.currency) ? input.currency : "EUR";
  return {
    currency,
    vatTreatment: suggestPurchaseVatTreatment(input),
    originalAmountCents:
      currency !== "EUR" && input.originalAmount != null && input.originalAmount > 0
        ? Math.round(input.originalAmount * 100)
        : null,
  };
}

/** A printed or looked-up rate is only usable when it is a positive number of a believable size. */
export function isUsableRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 1e-6 && value < 1e6;
}

/**
 * The line under the euro amount that says which rate priced it, e.g.
 * "Kurssi 1 USD = 0,9123 EUR (EKP 12.7.2026)". null when no rate was applied.
 */
export function fxRateLine(fx: {
  currency: string | null | undefined;
  fxRate: number | null | undefined;
  fxRateDate?: string | null;
  fxSource?: string | null;
}): string | null {
  if (!fx.currency || fx.currency === "EUR" || !isUsableRate(fx.fxRate)) return null;
  // A small unit value (JPY, KRW) needs more digits than 0,9123 to say anything.
  const rate = fx.fxRate.toLocaleString("fi-FI", { minimumFractionDigits: 4, maximumFractionDigits: fx.fxRate < 0.1 ? 6 : 4 });
  const parsedDate = fx.fxRateDate ? new Date(fx.fxRateDate) : null;
  const date =
    parsedDate && !Number.isNaN(parsedDate.getTime())
      ? new Intl.DateTimeFormat("fi-FI", { day: "numeric", month: "numeric", year: "numeric", timeZone: "UTC" }).format(parsedDate)
      : null;
  const origin = fx.fxSource === "document" ? "laskulla" : "EKP";
  return `Kurssi 1 ${fx.currency} = ${rate} EUR (${date ? `${origin} ${date}` : origin})`;
}

/** Finnish names for the treatments, shared by the web forms and the VAT page. */
export const VAT_TREATMENT_LABELS: Record<PurchaseVatTreatment, string> = {
  domestic: "Kotimainen ALV",
  eu_service: "Palveluosto EU-maasta (käännetty verovelvollisuus)",
  eu_goods: "Tavaraosto EU-maasta (käännetty verovelvollisuus)",
  non_eu_service: "Palveluosto EU:n ulkopuolelta (käännetty verovelvollisuus)",
  non_eu_goods: "Tavaroiden maahantuonti EU:n ulkopuolelta",
  foreign_vat_charged: "Ulkomainen myyjä veloitti Suomen ALV:n (ei vähennettävissä)",
};

/** One line under the choice: what the treatment does to the VAT return. */
export const VAT_TREATMENT_HINTS: Record<PurchaseVatTreatment, string> = {
  domestic: "",
  eu_service:
    "Laskussa ei ole ALV:ta. Vero lasketaan kohtaan 306 ja vähennetään samalla summalla kohdassa 307, joten maksettavaa ei jää.",
  eu_goods:
    "Laskussa ei ole ALV:ta. Vero lasketaan kohtaan 305 ja vähennetään samalla summalla kohdassa 307, joten maksettavaa ei jää.",
  non_eu_service:
    "Laskussa ei ole ALV:ta. Vero lasketaan kohtaan 301 ja vähennetään samalla summalla kohdassa 307, joten maksettavaa ei jää.",
  non_eu_goods:
    "Tuonnin ALV maksetaan Tullille tai ilmoitetaan erikseen. Sovellus ei laske sitä, vaan kuitti näkyy ALV-ilmoituksen tarkistettavissa.",
  foreign_vat_charged:
    "Myyjä veloitti Suomen ALV:n, jota ei voi vähentää. Anna myyjälle ALV-tunnuksesi, niin seuraavat laskut tulevat ilman veroa.",
};
