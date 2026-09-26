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

export function limitedModeNotice(english: boolean): string {
  if (english) {
    return "Limited mode: the language provider is not connected, so this is not a model answer. I can still use your books for matching, VAT rules, and calculated amounts.";
  }
  return "Rajattu tila: kielimallia ei ole yhdistetty, joten tämä ei ole mallin vastaus. Voin silti käyttää kirjanpitoasi täsmäytykseen, ALV-sääntöihin ja laskettuihin summiin.";
}

export function matchStatusReply(input: {
  totalTransactions: number;
  unmatched: number;
  openReceipts: number;
  english: boolean;
}): string | null {
  if (input.totalTransactions === 0) {
    return input.english
      ? "There are no bank transactions yet. Import a statement from the Pankki tab. That is not the same as everything being matched."
      : "Tiliotteen tapahtumia ei ole vielä. Tuo tiliote Pankki-välilehdeltä. Tämä ei tarkoita, että kaikki olisi täsmäytetty.";
  }
  if (input.unmatched === 0) {
    return input.english
      ? "Every bank transaction is already matched to a receipt."
      : "Kaikki tiliotteen tapahtumat on jo täsmäytetty kuitteihin.";
  }
  if (input.openReceipts === 0) {
    return input.english
      ? `There are ${input.unmatched} unmatched bank transactions and no open receipts. Add a receipt from Kuitit.`
      : `Täsmäyttämättömiä pankkitapahtumia on ${input.unmatched}, mutta avoimia kuitteja ei ole. Lisää kuitti Kuitit-välilehdeltä.`;
  }
  return null;
}
