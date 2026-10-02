/**
 * The assistant's scope: the owner's books, Finnish VAT and taxes, the business's money and how to
 * use LashKirja. Code, web pages and creative writing are turned away before the model is asked
 * (no tokens spent), and a reply that still carries code is not shown.
 */

const CODE_LANGUAGE =
  /(^|[^\p{L}])(html|css|javascript|typescript|python|kotlin|swift(ui)?|php|ruby|golang|rust|c\+\+|c#|bash|powershell|react|vue|node\.?js|jquery|sql)(?![\p{L}])/iu;
const CODE_WORD = /(^|[^\p{L}-])(koodi\w*|code|coding|kod|kodu|kodla\w*|script\w*|skript\w*|ohjelm\w*|program\w*|algoritm\w*|algorithm\w*)(?![\p{L}])/iu;
const WRITE_VERB =
  /(^|[^\p{L}])(write|kirjoita\w*|tee|tehdä|luo|generate|create|make|build|yaz\w*|oluştur\w*|hazırla\w*|koda)(?![\p{L}])/iu;
const CREATIVE = /(^|[^\p{L}])(runo\w*|poem\w*|şiir\w*|essee\w*|essay\w*|tarin[ao]\w*|story|hikaye\w*|laulu\w*|song\w*|lyrics|vitsi\w*|joke\w*|fıkra\w*|novel\w*|roman\w*)(?![\p{L}])/iu;
const MARKUP = /<\/?(html|head|body|div|span|script|style|table|form|input|button|h[1-6])\b[^>]*>/i;

export function offTopicRequest(text: string): boolean {
  if (MARKUP.test(text)) return true;
  if (CODE_LANGUAGE.test(text)) return true;
  if (CODE_WORD.test(text) && WRITE_VERB.test(text)) return true;
  return CREATIVE.test(text);
}

export function replyLooksLikeCode(text: string): boolean {
  if (text.includes("```")) return true;
  if (/<!doctype/i.test(text) || MARKUP.test(text)) return true;
  return /^\s*(def|function|class|import|const|let|var|public|private|SELECT|CREATE)\s+[\w(]/m.test(text);
}

/** The refusal's language. A short request ("html kod yaz") carries too few words for
 *  replyLanguage, so the Turkish words such requests use count too. */
export function scopeLanguage(text: string, detected: "fi" | "en" | "tr"): "fi" | "en" | "tr" {
  if (detected !== "fi") return detected;
  return /(^|[^\p{L}])(yaz\w*|kod|kodu|bana|şiir\w*|oluştur\w*|hazırla\w*|sayfa\w*|mısın|misin)(?![\p{L}])/iu.test(text) ? "tr" : "fi";
}

export function scopeRefusal(language: "fi" | "en" | "tr"): string {
  switch (language) {
    case "en":
      return "I can only help with your bookkeeping: receipts, invoices, the bank, VAT and how to use LashKirja. Ask me about those.";
    case "tr":
      return "Yalnızca muhasebenle ilgili konularda yardımcı olabilirim: fişler, faturalar, banka, ALV ve LashKirja'nın kullanımı. Bunlarla ilgili sorabilirsin.";
    default:
      return "Autan vain kirjanpidossasi: kuitit, laskut, pankki, ALV ja LashKirjan käyttö. Kysy niistä.";
  }
}

/** For the system prompt: the same scope in the model's words. */
export const SCOPE_RULE =
  "Scope: only the user's bookkeeping, Finnish VAT and taxes, the business's money, and using LashKirja. " +
  "Politely refuse anything else (writing or explaining program code, HTML or web pages, essays, stories, poems, general knowledge, translations) " +
  "in one sentence and name what you can help with. Never output code, markup or code blocks.";
