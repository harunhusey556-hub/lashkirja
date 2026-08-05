export interface ReceiptCategory {
  id: string;
  label: string;
  aiHint: string;
}

/** Canonical expense/income categories for receipts and AI extraction. */
export const RECEIPT_CATEGORIES: readonly ReceiptCategory[] = [
  { id: "myynti", label: "Myynti", aiHint: "Asiakastyöt, laskut, tuotemyynti, Holvi/Zettle tilitykset" },
  { id: "tarvikkeet", label: "Tarvikkeet & ostot", aiHint: "Tukku, tarvikkeet, tavaraostot" },
  { id: "vuokra", label: "Vuokra & toimitilat", aiHint: "Toimitilavuokra, Finnvacum" },
  { id: "sähkö", label: "Sähkö", aiHint: "Sähkölasku, Helen" },
  { id: "vesi", label: "Vesi & jätevesi", aiHint: "Vesilasku, kunnan vesi" },
  { id: "puhelin/netti", label: "Puhelin & data", aiHint: "DNA, Elisa, Telia, netti" },
  { id: "ohjelmistot", label: "ATK & ohjelmistot", aiHint: "SaaS, Cloudflare, GitHub, Merit" },
  { id: "polttoaine", label: "Polttoaine", aiHint: "Neste, ABC, St1, tankkaus" },
  { id: "rahti", label: "Rahti & kuljetus", aiHint: "Posti, DHL, toimituskulut" },
  { id: "matkakulut", label: "Matkakulut", aiHint: "Hotelli, lento, juna, taksi" },
  { id: "markkinointi", label: "Markkinointi", aiHint: "Mainos, some, Google Ads" },
  { id: "koulutus", label: "Koulutus", aiHint: "Kurssit, koulutusmateriaalit" },
  { id: "vakuutus", label: "Vakuutukset", aiHint: "Fennia, Pohjola, yritysvakuutus" },
  { id: "työeläke", label: "TyEL / työeläke", aiHint: "Varma, Elo, YEL-vakuutus" },
  { id: "työllisyysrahasto", label: "Työllisyysrahasto", aiHint: "Työllisyysrahaston maksu" },
  { id: "pankki", label: "Pankki- & palvelumaksut", aiHint: "Holvi, tilimaksut, palvelumaksu" },
  { id: "verot", label: "Verot & ennakkomaksut", aiHint: "Verohallinto, ennakkomaksu" },
  { id: "kuntavero", label: "Kunnallisvero", aiHint: "Helsingin kaupunki, kunnallisvero" },
  { id: "rahoitus", label: "Rahoitus & lainat", aiHint: "Qred, lainan lyhennys tai korko" },
  { id: "palkka", label: "Palkat", aiHint: "Palkkakuitti (harvinainen)" },
  { id: "muut", label: "Muut", aiHint: "Muu kulu jota ei sovi muihin luokkiin" },
] as const;

export const RECEIPT_CATEGORY_IDS = RECEIPT_CATEGORIES.map((c) => c.id);

const CATEGORY_ALIASES: Record<string, string> = {
  sahkö: "sähkö",
  sahko: "sähkö",
  tyel: "työeläke",
  yel: "työeläke",
  "työelake": "työeläke",
  saas: "ohjelmistot",
  software: "ohjelmistot",
  atk: "ohjelmistot",
  neste: "polttoaine",
  posti: "rahti",
  dhl: "rahti",
  helen: "sähkö",
  varma: "työeläke",
  elo: "työeläke",
  tulo: "myynti",
  myynti: "myynti",
};

export function isKnownCategory(id: string | null | undefined): boolean {
  if (!id) return false;
  return RECEIPT_CATEGORY_IDS.includes(id);
}

export function categoryLabel(id: string): string {
  return RECEIPT_CATEGORIES.find((c) => c.id === id)?.label ?? id;
}

export function categoriesForAiPrompt(): string {
  return RECEIPT_CATEGORIES.map((c) => `- ${c.id}: ${c.aiHint}`).join("\n");
}

export function normalizeExtractedCategory(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  if (isKnownCategory(trimmed)) return trimmed;
  const alias = CATEGORY_ALIASES[trimmed];
  if (alias && isKnownCategory(alias)) return alias;
  for (const cat of RECEIPT_CATEGORIES) {
    if (trimmed === cat.label.toLowerCase()) return cat.id;
  }
  return null;
}
