import { limitedModeNotice } from "./chat-policy";

/**
 * Replies generated before OWN-09 began with a "Rajattu tila" / "Limited mode"
 * paragraph. The generator no longer writes it, but those replies are stored
 * in ChatMessage.content and would show again whenever an old conversation
 * loads. The migration 20260929120000_strip_legacy_chat_notice rewrites the
 * stored rows once; this sanitiser covers the same text at display time
 * (server GET, model context and client render), so a row the migration did
 * not reach — a restored backup, a slow deploy — never shows the label.
 *
 * Keep these strings byte-identical to the SQL migration.
 */
export const LEGACY_LIMITED_NOTICE_FI =
  "Rajattu tila: kielimallia ei ole yhdistetty, joten tämä ei ole mallin vastaus. Voin silti käyttää kirjanpitoasi täsmäytykseen, ALV-sääntöihin ja laskettuihin summiin.";
export const LEGACY_LIMITED_NOTICE_EN =
  "Limited mode: the language provider is not connected, so this is not a model answer. I can still use your books for matching, VAT rules, and calculated amounts.";

/**
 * The calm notice as the SQL migration wrote it into stored rows, before the
 * glossary sweep changed "täsmäyttää" to "kohdistaa" (F27). The migration is
 * applied history and stays byte-identical; the display-time sanitiser shows
 * these rows with the current wording instead.
 */
export const PREVIOUS_LIMITED_NOTICE_FI =
  "Tähän en osaa vielä vastata. Voin täsmäyttää kuitit tiliotteeseen ja kertoa tämän kuun ALV:n.";

// Any first paragraph that opens with the old label, in case an earlier
// wording than the two above was stored.
const LEGACY_PARAGRAPH = /^\s*(Rajattu tila|Rajoitettu tila|Limited mode)\s*:[^\n]*(?:\r?\n\s*|$)/i;

/** True when the text still carries the pre-OWN-09 notice. */
export function hasLegacyLimitedNotice(content: string): boolean {
  return LEGACY_PARAGRAPH.test(content);
}

/**
 * Removes the legacy notice paragraph from an assistant reply. A reply that
 * was only the notice becomes the current calm notice in the same language.
 * Anything else is returned unchanged.
 */
export function stripLegacyLimitedNotice(content: string): string {
  const current = (text: string) => text.split(PREVIOUS_LIMITED_NOTICE_FI).join(limitedModeNotice(false));
  const match = LEGACY_PARAGRAPH.exec(content);
  if (!match) return current(content);
  const english = /^limited mode$/i.test(match[1]);
  const rest = content.slice(match[0].length).replace(/^\s+/, "");
  return current(rest) || limitedModeNotice(english);
}

/** Display-time filter for one stored chat row: only assistant text changes. */
export function displayChatContent(role: string, content: string): string {
  return role === "assistant" ? stripLegacyLimitedNotice(content) : content;
}
