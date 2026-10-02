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
  return /^(hei|moi|terve|moikka|hello|hi|hey|good morning|good afternoon)$/.test(normalized);
}

export function isMatchRequest(text: string): boolean {
  const normalized = text.toLowerCase();
  return /kohdist|täsmäyt|yhdistä kuit|\bmatch\b/.test(normalized);
}

// Intent is read from whole words, never from a substring: "palvelun" holds "alv",
// "ovat" holds "vat", "kotitalousvähennys" holds "vähennys" (F58).
const BEFORE = String.raw`(?<![\p{L}])`;
const AFTER = String.raw`(?![\p{L}])`;
const VAT_WORD = new RegExp(String.raw`${BEFORE}(?:alv|arvonlisäver\p{L}*|vat)${AFTER}`, "u");
const VAT_THIS_MONTH_CUE = new RegExp(
  String.raw`${BEFORE}(?:kuu|kuun|kuussa|kuulta|kuukau\p{L}*|tämän|tässä|maksan|maksettava\p{L}*|paljonko|palautus\p{L}*|month|owe|pay|much)${AFTER}`,
  "u"
);

/** The one VAT question the app can answer exactly from the books: what this month's VAT is. */
export function asksVatThisMonth(text: string): boolean {
  const normalized = text.toLowerCase().trim();
  if (!VAT_WORD.test(normalized)) return false;
  return VAT_THIS_MONTH_CUE.test(normalized) || /^(?:alv|vat)\s*[?!.]*$/.test(normalized);
}

const PROFILE_WORD = new RegExp(String.raw`${BEFORE}(?:profiili\p{L}*|yritysmuoto\p{L}*)${AFTER}`, "u");
const SHOW_CUE = new RegExp(String.raw`${BEFORE}(?:mikä|mitkä|mitä|näytä|kerro|what|show)${AFTER}`, "u");

/** The business profile is read out only when the question asks to see it. */
export function asksAboutProfile(text: string): boolean {
  const normalized = text.toLowerCase();
  return PROFILE_WORD.test(normalized) && SHOW_CUE.test(normalized);
}

export function greetingReply(english: boolean): string {
  if (english) {
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
