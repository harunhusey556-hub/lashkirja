import { z } from "zod";

/** A chip answers one onboarding question: a flag, a choice or a tag. */
export type ChipValue = string | boolean;

export const SALES_TYPES = ["ripsipalvelut", "kulmapalvelut", "koulutus", "tuotemyynti"] as const;
export const EXPENSE_CATEGORIES = ["tarvikkeet", "vuokra", "markkinointi", "koulutuskulut"] as const;
export const VAT_PERIODS = ["month", "quarter", "year"] as const;

/** Company types shared by onboarding, settings and the profile PATCH schema. */
export const ENTITY_TYPES = ["toiminimi", "kevytyrittaja", "oy"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const ENTITY_TYPE_OPTIONS: { value: EntityType; label: string }[] = [
  { value: "toiminimi", label: "Toiminimi" },
  { value: "kevytyrittaja", label: "Kevytyrittäjä" },
  { value: "oy", label: "Osakeyhtiö (Oy)" },
];

export interface BusinessProfile {
  entityType: EntityType;
  vatRegistered: boolean;
  vatPeriod: (typeof VAT_PERIODS)[number];
  salesTypes: string[];
  expenseCategories: string[];
  summaryNote?: string;
}

export const businessProfileSchema = z.object({
  entityType: z.enum(ENTITY_TYPES),
  vatRegistered: z.boolean(),
  vatPeriod: z.enum(VAT_PERIODS),
  salesTypes: z.array(z.enum(SALES_TYPES)).max(8),
  expenseCategories: z.array(z.enum(EXPENSE_CATEGORIES)).max(8),
  summaryNote: z.string().trim().max(500).optional(),
});

export function defaultBusinessProfile(): BusinessProfile {
  return {
    entityType: "toiminimi",
    vatRegistered: false,
    vatPeriod: "month",
    salesTypes: ["ripsipalvelut"],
    expenseCategories: ["tarvikkeet"],
  };
}

export interface OnboardingChatStep {
  id: string;
  question: string;
  field: keyof BusinessProfile;
  chips: { label: string; value: ChipValue }[];
  multiSelect?: boolean;
}

export const ONBOARDING_STEPS: OnboardingChatStep[] = [
  {
    id: "entityType",
    question: "Moi! 👋 Olen LashKirjan tekoälyapuri. Aloitetaan tekemällä kirjanpidosovelluksestasi juuri sinun yrityksellesi sopiva. Mikä on yritysmuotosi?",
    field: "entityType",
    chips: [
      { label: "✨ Toiminimi (Yksityinen elinkeinonharjoittaja)", value: "toiminimi" },
      { label: "💼 Kevytyrittäjä", value: "kevytyrittaja" },
      { label: "🏢 Osakeyhtiö (Oy)", value: "oy" },
    ],
  },
  {
    id: "vatRegistered",
    question: "Oletko rekisteröitynyt arvonlisäverovelvolliseksi (ALV-rekisteriin)?",
    field: "vatRegistered",
    chips: [
      { label: "✅ Kyllä, olen ALV-rekisterissä", value: true },
      { label: "❌ En ole ALV-rekisterissä", value: false },
    ],
  },
  {
    id: "vatPeriod",
    question: "Kuinka usein ilmoitat ja maksat ALV:t Verohallinnolle (OmaVero)?",
    field: "vatPeriod",
    chips: [
      { label: "📅 Kuukausittain (tavallisin)", value: "month" },
      { label: "📆 Neljännesvuosittain (3kk)", value: "quarter" },
      { label: "🗓️ Vuosittain", value: "year" },
    ],
  },
  {
    id: "salesTypes",
    question: "Mitä palveluita tai tuotteita yrityksesi pääasiassa myy? (Voit valita useita)",
    field: "salesTypes",
    multiSelect: true,
    chips: [
      { label: "👁️ Ripsienpidennykset & huollot", value: "ripsipalvelut" },
      { label: "✨ Kulmapalvelut (Lamination/Laminointi)", value: "kulmapalvelut" },
      { label: "🎓 Koulutukset & kurssit", value: "koulutus" },
      { label: "🛍️ Kauneustuotteiden jälleenmyynti", value: "tuotemyynti" },
    ],
  },
  {
    id: "expenseCategories",
    question: "Mitkä ovat säännöllisimpiä hankintojasi tai kulujasi?",
    field: "expenseCategories",
    multiSelect: true,
    chips: [
      { label: "📦 Ripsiliimat, kuidut & hoitotuotteet", value: "tarvikkeet" },
      { label: "🏬 Liiketilan vuokra & hoitolakulut", value: "vuokra" },
      { label: "📲 Markkinointi & ajanvarausjärjestelmät", value: "markkinointi" },
      { label: "📚 Koulutukset, kurssit & ammattikirjallisuus", value: "koulutuskulut" },
    ],
  },
];

export function parseBusinessDetails(jsonStr?: string | null): BusinessProfile {
  const fallback = defaultBusinessProfile();
  if (!jsonStr) return fallback;
  try {
    const parsed = businessProfileSchema.safeParse(JSON.parse(jsonStr));
    return parsed.success ? parsed.data : fallback;
  } catch {
    return fallback;
  }
}

export function generateProfileSummary(profile: BusinessProfile): string {
  const entityName =
    profile.entityType === "kevytyrittaja"
      ? "Kevytyrittäjä"
      : profile.entityType === "oy"
      ? "Osakeyhtiö (Oy)"
      : "Toiminimi";

  const vatStatus = profile.vatRegistered
    ? `ALV-rekisterissä (kausi: ${
        profile.vatPeriod === "quarter"
          ? "neljännesvuosi"
          : profile.vatPeriod === "year"
          ? "vuosi"
          : "kuukausi"
      })`
    : "Ei ALV-rekisterissä (ALV 0% myynnit & ostot)";

  const sales = (profile.salesTypes || []).join(", ") || "Ripsipalvelut";
  const expenses = (profile.expenseCategories || []).join(", ") || "Tarvikkeet, vuokra";

  return `Yritysmuoto: ${entityName} | ALV: ${vatStatus} | Myynnit: ${sales} | Kulut: ${expenses}`;
}

export interface VatProfile {
  isSingleRate: boolean;
  defaultSalesRate: number;
  salesRates: { type: string; rate: number }[];
  isVatRegistered: boolean;
}

export function deriveVatProfile(profile: BusinessProfile): VatProfile {
  if (!profile.vatRegistered) {
    return {
      isSingleRate: true,
      defaultSalesRate: 0,
      salesRates: profile.salesTypes.map(type => ({ type, rate: 0 })),
      isVatRegistered: false,
    };
  }

  // Map known sales types to their Finnish VAT rates (2026 standard is 25.5%)
  const rates = profile.salesTypes.map(type => {
    // Currently, all options in the UI (ripsipalvelut, kulmapalvelut, tuotemyynti, koulutus)
    // map to the standard 25.5% rate for typical beauty businesses.
    return { type, rate: 25.5 };
  });

  const uniqueRates = new Set(rates.map(r => r.rate));
  
  return {
    isSingleRate: uniqueRates.size <= 1,
    defaultSalesRate: rates.length > 0 ? rates[0].rate : 25.5,
    salesRates: rates,
    isVatRegistered: true,
  };
}
