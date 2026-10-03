/** Pure chat decisions: greetings, language, and empty matching. */

const ENGLISH_HINTS = new Set([
  "hello",
  "hi",
  "hey",
  "what",
  "how",
  "the",
  "can",
  "please",
  "vat",
  "tax",
  "help",
  "thanks",
  "thank",
  "much",
  "owe",
  "last",
  "month",
  "quarter",
  "year",
  "did",
  "was",
  "is",
  "my",
  "for",
  "this",
  "show",
  "me",
]);

export function prefersEnglish(text: string): boolean {
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  if (words.length === 0) return false;
  if (words.some((word) => word === "hello" || word === "hi" || word === "hey")) return true;
  const hits = words.filter((word) => ENGLISH_HINTS.has(word)).length;
  return hits >= 2 && hits / words.length >= 0.34;
}

const TURKISH_HINTS = new Set(["ve", "ile", "ne", "nedir", "nasıl", "kaç", "kdv", "dahil", "hariç", "fiyat", "fiyatı", "ise", "mi", "mı", "için", "fatura", "tutar", "bu", "bir"]);

/** The reply's language: Finnish by default, English or Turkish when the message is clearly in it. */
export function replyLanguage(text: string): "fi" | "en" | "tr" {
  const lower = text.toLocaleLowerCase("tr");
  const words = lower.match(/[\p{L}']+/gu) ?? [];
  const turkish = words.filter((word) => TURKISH_HINTS.has(word)).length;
  if (/[ğış]/.test(lower) ? turkish >= 1 : turkish >= 2) return "tr";
  return prefersEnglish(text) ? "en" : "fi";
}

export function isGreeting(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[!?.]+$/g, "");
  return /^(hei|moi|terve|moikka|hello|hi|hey|good morning|good afternoon|merhaba|selam|hej|hallå)$/.test(normalized);
}

// Matching receipts to bank rows: Finnish, English, Turkish ("eşleştir") and Swedish ("matcha").
const MATCH_WORD = /kohdist|täsmäyt|yhdistä kuit|\bmatch\b|(?<![\p{L}])matcha\p{L}*|e[şs]le[şs]tir|koppla kvitt/u;

export function isMatchRequest(text: string): boolean {
  return MATCH_WORD.test(text.replace(/İ/g, "i").toLowerCase());
}

// Intent is read from whole words, never from a substring: "palvelun" holds "alv",
// "ovat" holds "vat", "kotitalousvähennys" holds "vähennys" (F58).
const BEFORE = String.raw`(?<![\p{L}])`;
const AFTER = String.raw`(?![\p{L}])`;
const word = (source: string) => new RegExp(String.raw`${BEFORE}(?:${source})${AFTER}`, "u");
const VAT_WORD = word(String.raw`alv|arvonlisäver\p{L}*|vat|kdv|katma değer vergisi|moms\p{L}*|mervärdesskatt\p{L}*`);
const VAT_FIGURE_CUE = word(
  [
    String.raw`kuu|kuun|kuussa|kuulta|kuukau\p{L}*|tämän|tässä|maksan|maksettava\p{L}*|paljonko|palautus\p{L}*`,
    String.raw`month|owe|pay|much`,
    String.raw`ne kadar|kaç|öde\p{L}*|ode\p{L}*|iade\p{L}*|borc\p{L}*|borç\p{L}*`,
    String.raw`hur mycket|betala\p{L}*|skyld\p{L}*|återbetal\p{L}*`,
  ].join("|")
);
// "ALV-kanta", "VAT rate", "KDV oranı": a question about the rate, not about the books.
const VAT_RATE_WORD = word(String.raw`kanta|kannan|kannat|verokanta|rate|rates|oran\p{L}*|momssats\p{L}*|skattesats\p{L}*`);

export type VatPeriodKind = "month" | "quarter" | "year";

export interface AskedVatPeriod {
  /** "2026-09", "2026-Q3" or "2026": the ALV report's period key. */
  key: string;
  kind: VatPeriodKind;
  /** The question named the period; otherwise it is the owner's current VAT period. */
  explicit: boolean;
}

// Per month: the Finnish stem and Turkish name take endings ("syyskuun", "eylülde");
// English and Swedish names only a genitive s, so "majoitus" is not May nor "julistus" July.
const MONTH_WORDS: Array<{ inflected: string[]; plain: string[] }> = [
  { inflected: ["tammikuu", "ocak"], plain: ["january", "januari"] },
  { inflected: ["helmikuu", "[şs]ubat"], plain: ["february", "februari"] },
  { inflected: ["maaliskuu", "mart"], plain: ["march", "mars"] },
  { inflected: ["huhtikuu", "nisan"], plain: ["april"] },
  { inflected: ["toukokuu", "may[ıi]s"], plain: ["maj", String.raw`(?<=(?:in|for|of)\s)may`, String.raw`may(?=\s+20\d{2})`] },
  { inflected: ["kesäkuu", "haziran"], plain: ["june", "juni"] },
  { inflected: ["heinäkuu", "temmuz"], plain: ["july", "juli"] },
  { inflected: ["elokuu", "a[ğg]ustos"], plain: ["august", "augusti"] },
  { inflected: ["syyskuu", "eyl[üu]l"], plain: ["september"] },
  { inflected: ["lokakuu", "ekim"], plain: ["october", "oktober"] },
  { inflected: ["marraskuu", "kas[ıi]m"], plain: ["november"] },
  { inflected: ["joulukuu", "aral[ıi]k"], plain: ["december"] },
];
const MONTH_RES = MONTH_WORDS.map(({ inflected, plain }) => {
  const alternatives = [...inflected.map((name) => `${name}\\p{L}*`), ...plain.map((name) => `${name}s?`)];
  return new RegExp(`${BEFORE}(?:${alternatives.join("|")})${AFTER}`, "u");
});

const QUARTER_ORDINALS: string[] = [
  String.raw`ensimmäi\p{L}*|first|1st|birinci|första`,
  String.raw`toi\p{L}*|second|2nd|ikinci|andra`,
  String.raw`kolma\p{L}*|third|3rd|üçüncü|ucuncu|tredje`,
  String.raw`neljä\p{L}*|neljännen|fourth|4th|dördüncü|dorduncu|fjärde`,
];
const QUARTER_NOUN = String.raw`(?:neljänne\p{L}*|kvartaal\p{L}*|vuosineljänne\p{L}*|quarter|çeyre\p{L}*|ceyre\p{L}*|kvartal\p{L}*)`;

const PREVIOUS = String.raw`viime|edellinen|edellisen|edellisessä|edelliseltä|last|previous|prior|geçen|gecen|önceki|onceki|förra|föregående`;
const CURRENT = String.raw`tämä|tämän|tässä|tältä|kuluva|kuluvan|kuluvassa|this|current|bu|denna|den här|innevarande|detta`;
const MONTH_NOUN = String.raw`(?:kuu|kuun|kuussa|kuulta|kuukau\p{L}*|month|ay|ayın|ayki|ayda|aydaki|ayı|månad\p{L}*)`;
const YEAR_NOUN = String.raw`(?:vuosi|vuoden|vuonna|vuodelta|year|yıl\p{L}*|yil\p{L}*|år|året|årets)`;
const PERIOD_NOUN = String.raw`(?:kausi|kauden|kaudelta|period|dönem\p{L}*|donem\p{L}*|perioden|period)`;
const relative = (which: string, noun: string) => new RegExp(String.raw`${BEFORE}(?:${which})\s+${noun}${AFTER}`, "u");
const PREVIOUS_MONTH = relative(PREVIOUS, MONTH_NOUN);
const CURRENT_MONTH = relative(CURRENT, MONTH_NOUN);
const PREVIOUS_QUARTER = relative(PREVIOUS, QUARTER_NOUN);
const CURRENT_QUARTER = relative(CURRENT, QUARTER_NOUN);
const PREVIOUS_YEAR = relative(PREVIOUS, YEAR_NOUN);
const CURRENT_YEAR = new RegExp(String.raw`${BEFORE}(?:(?:${CURRENT})\s+${YEAR_NOUN}|i år)${AFTER}`, "u");
const PREVIOUS_PERIOD = relative(PREVIOUS, PERIOD_NOUN);

function helsinkiYearMonth(now: Date): { year: number; month: number } {
  const [year, month] = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Helsinki", year: "numeric", month: "2-digit" })
    .format(now)
    .split("-")
    .map(Number);
  return { year, month };
}

const pad = (month: number) => String(month).padStart(2, "0");
const monthKeyOf = (year: number, month: number) => `${year}-${pad(month)}`;

function shiftMonth(year: number, month: number, by: number): { year: number; month: number } {
  const total = year * 12 + (month - 1) + by;
  return { year: Math.floor(total / 12), month: (total % 12) + 1 };
}

function currentKey(kind: VatPeriodKind, year: number, month: number, back = 0): string {
  if (kind === "year") return String(year - back);
  if (kind === "quarter") {
    const index = year * 4 + Math.floor((month - 1) / 3) - back;
    return `${Math.floor(index / 4)}-Q${(index % 4) + 1}`;
  }
  const shifted = shiftMonth(year, month, -back);
  return monthKeyOf(shifted.year, shifted.month);
}

function normalizeQuestion(text: string): string {
  // Turkish capital I/İ lower-case to ı/i; everything else as usual.
  return text.replace(/İ/g, "i").toLowerCase();
}

/**
 * The VAT period a question asks about: a named month or quarter, last or this
 * month/quarter/year, in Finnish, English, Turkish or Swedish. A question that
 * names none asks about the owner's current VAT period (their ALV-verokausi).
 */
export function parseVatPeriod(text: string, now: Date, ownerKind: VatPeriodKind): AskedVatPeriod {
  const lower = normalizeQuestion(text);
  const today = helsinkiYearMonth(now);
  const yearMatch = /(?<!\d)(20\d{2})(?!\d)/.exec(lower);
  const namedYear = yearMatch ? Number(yearMatch[1]) : null;

  const iso = /(?<!\d)(20\d{2})-(0[1-9]|1[0-2]|q[1-4])(?![\d\p{L}])/u.exec(lower);
  if (iso) {
    const quarter = iso[2].startsWith("q");
    return { key: `${iso[1]}-${quarter ? iso[2].toUpperCase() : iso[2]}`, kind: quarter ? "quarter" : "month", explicit: true };
  }

  let quarter: number | null = null;
  const q = /(?<![\p{L}\d])q([1-4])(?![\p{L}\d])/u.exec(lower);
  if (q) quarter = Number(q[1]);
  const numbered = new RegExp(String.raw`(?<!\d)([1-4])\.\s*${QUARTER_NOUN}`, "u").exec(lower);
  if (!quarter && numbered) quarter = Number(numbered[1]);
  if (!quarter) {
    const ordinal = QUARTER_ORDINALS.findIndex((words) =>
      new RegExp(String.raw`${BEFORE}(?:${words})\s+${QUARTER_NOUN}${AFTER}`, "u").test(lower)
    );
    if (ordinal >= 0) quarter = ordinal + 1;
  }
  if (quarter) {
    const currentQuarter = Math.floor((today.month - 1) / 3) + 1;
    const year = namedYear ?? (quarter > currentQuarter ? today.year - 1 : today.year);
    return { key: `${year}-Q${quarter}`, kind: "quarter", explicit: true };
  }

  const monthIndex = MONTH_RES.findIndex((re) => re.test(lower));
  if (monthIndex >= 0) {
    const month = monthIndex + 1;
    const year = namedYear ?? (month > today.month ? today.year - 1 : today.year);
    return { key: monthKeyOf(year, month), kind: "month", explicit: true };
  }

  if (PREVIOUS_MONTH.test(lower)) return { key: currentKey("month", today.year, today.month, 1), kind: "month", explicit: true };
  if (CURRENT_MONTH.test(lower)) return { key: currentKey("month", today.year, today.month), kind: "month", explicit: true };
  if (PREVIOUS_QUARTER.test(lower)) return { key: currentKey("quarter", today.year, today.month, 1), kind: "quarter", explicit: true };
  if (CURRENT_QUARTER.test(lower)) return { key: currentKey("quarter", today.year, today.month), kind: "quarter", explicit: true };
  if (PREVIOUS_YEAR.test(lower)) return { key: String(today.year - 1), kind: "year", explicit: true };
  if (CURRENT_YEAR.test(lower)) return { key: String(today.year), kind: "year", explicit: true };
  if (PREVIOUS_PERIOD.test(lower)) return { key: currentKey(ownerKind, today.year, today.month, 1), kind: ownerKind, explicit: true };
  if (namedYear && new RegExp(`${BEFORE}${YEAR_NOUN}${AFTER}`, "u").test(lower)) {
    return { key: String(namedYear), kind: "year", explicit: true };
  }
  return { key: currentKey(ownerKind, today.year, today.month), kind: ownerKind, explicit: false };
}

/**
 * The VAT question the app answers exactly from the books: what the VAT of a
 * period is (this month, last month, September, Q3, ...).
 */
export function asksBookedVat(text: string): boolean {
  const normalized = normalizeQuestion(text).trim();
  if (!VAT_WORD.test(normalized)) return false;
  if (/^(?:alv|vat|kdv|moms)\s*[?!.]*$/.test(normalized)) return true;
  if (VAT_RATE_WORD.test(normalized)) return false;
  return VAT_FIGURE_CUE.test(normalized) || parseVatPeriod(normalized, new Date(), "month").explicit;
}

/** @deprecated The question may name any period now; kept for callers and tests. */
export const asksVatThisMonth = asksBookedVat;

const PROFILE_WORD = new RegExp(String.raw`${BEFORE}(?:profiili\p{L}*|yritysmuoto\p{L}*)${AFTER}`, "u");
const SHOW_CUE = new RegExp(String.raw`${BEFORE}(?:mikä|mitkä|mitä|näytä|kerro|what|show)${AFTER}`, "u");

/** The business profile is read out only when the question asks to see it. */
export function asksAboutProfile(text: string): boolean {
  const normalized = text.toLowerCase();
  return PROFILE_WORD.test(normalized) && SHOW_CUE.test(normalized);
}

export function greetingReply(language: boolean | "fi" | "en" | "tr"): string {
  if (language === "tr") {
    return "Merhaba. Fişleri banka hareketleriyle eşleştirebilir, KDV'yi anlatabilir ya da kayıtlarındaki tutarlara bakabilirim. Ne lazım?";
  }
  if (language === true || language === "en") {
    return "Hello. I can match receipts to bank rows, explain VAT, or look up amounts from your books. What do you need?";
  }
  return "Hei. Voin kohdistaa kuitteja tiliotteeseen ja kertoa tämän kuun ALV:n. Miten voin auttaa?";
}

/**
 * The calm reply when a question needs the language model and none is
 * configured on the server. It says what does work; it never names the
 * provider, a setting or a "limited mode" (OWN-09).
 */
export function limitedModeNotice(english: boolean): string {
  if (english) {
    return "I can't answer that yet. I can match receipts to bank rows and tell you this month's VAT.";
  }
  return "Tähän en osaa vielä vastata, mutta voin kohdistaa kuitit tiliotteeseen ja kertoa tämän kuun ALV:n.";
}

/** A transient failure: the model is configured but did not answer this time. */
export function providerFailedNotice(english: boolean): string {
  if (english) {
    return "I couldn't get an answer just now. Try again in a moment.";
  }
  return "En saanut vastausta juuri nyt. Yritä hetken päästä uudelleen.";
}

export function matchStatusReply(input: {
  totalTransactions: number;
  unmatched: number;
  openReceipts: number;
  english: boolean;
}): string | null {
  if (input.totalTransactions === 0) {
    return input.english
      ? 'There are no bank transactions yet. Go to Kirjanpito → Pankkitilit to connect or sync the bank. A statement file can still be imported there. That is not the same as everything being matched.'
      : "Pankkitapahtumia ei ole vielä. Siirry Kirjanpito → Pankkitilit ja yhdistä tai hae pankki. Tiliotteen voi yhä tuoda sieltä. Tämä ei tarkoita, että kaikki olisi kohdistettu.";
  }
  if (input.unmatched === 0) {
    return input.english
      ? "Every bank transaction is already matched to a receipt."
      : "Kaikki tiliotteen tapahtumat on jo kohdistettu kuitteihin.";
  }
  if (input.openReceipts === 0) {
    return input.english
      ? `There are ${input.unmatched} unmatched bank transactions and no open receipts. Add one from "+" → "Kuvaa kuitti".`
      : `Kohdistamattomia pankkitapahtumia on ${input.unmatched}, mutta avoimia kuitteja ei ole. Valitse "+"-valikosta Kuvaa kuitti.`;
  }
  return null;
}
