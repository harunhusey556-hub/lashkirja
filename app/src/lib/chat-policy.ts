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

export function isGreeting(text: string): boolean {
  const normalized = text.trim().toLowerCase().replace(/[!?.]+$/g, "");
  return /^(hei|moi|terve|moikka|hello|hi|hey|good morning|good afternoon)$/.test(normalized);
}

export function isMatchRequest(text: string): boolean {
  const normalized = text.toLowerCase();
  return /täsmäyt|yhdistä|\bmatch\b/.test(normalized);
}

export function greetingReply(english: boolean): string {
  if (english) {
    return "Hello. I can match receipts to bank rows, explain VAT, or look up amounts from your books. What do you need?";
  }
  return "Hei. Voin täsmäyttää kuitteja tiliotteeseen, selittää ALV:n tai hakea summia kirjanpidostasi. Miten voin auttaa?";
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
  return "Tähän en osaa vielä vastata. Voin täsmäyttää kuitit tiliotteeseen ja kertoa tämän kuun ALV:n.";
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
      : "Pankkitapahtumia ei ole vielä. Siirry Kirjanpito → Pankkitilit ja yhdistä tai hae pankki. Tiliotteen voi yhä tuoda sieltä. Tämä ei tarkoita, että kaikki olisi täsmäytetty.";
  }
  if (input.unmatched === 0) {
    return input.english
      ? "Every bank transaction is already matched to a receipt."
      : "Kaikki tiliotteen tapahtumat on jo täsmäytetty kuitteihin.";
  }
  if (input.openReceipts === 0) {
    return input.english
      ? `There are ${input.unmatched} unmatched bank transactions and no open receipts. Add one from "+" → "Kuvaa kuitti".`
      : `Täsmäyttämättömiä pankkitapahtumia on ${input.unmatched}, mutta avoimia kuitteja ei ole. Lisää kuitti "+"-valikosta (Kuvaa kuitti).`;
  }
  return null;
}
