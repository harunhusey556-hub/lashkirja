/**
 * Sanitizes user-provided text input before it is saved to the database.
 * - Strips well-formed HTML tags and comments (a "<" followed by a letter up
 *   to its closing ">"); a lone "<" or ">" as in "a < b" or "<3" is ordinary
 *   text and is kept
 * - Strips control characters (U+0000 to U+001F) except newlines (U+000A)
 * - Repeats the tag removal until the text is stable, so nested tags cannot rebuild one
 * - Trims leading and trailing whitespace
 *
 * Stored text is always rendered escaped, so this is defence in depth, not the
 * thing that makes output safe: it must never eat text that is not markup.
 */
const HTML_COMMENT = /<!--[\s\S]*?-->/g;
const HTML_TAG =
  /<\/?[a-z][a-z0-9-]*(?:\s+[^\s=<>"']+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'<>]+))*\s*\/?>/gi;

export function sanitizeText(input: string | null | undefined): string | null {
  if (!input || typeof input !== "string") {
    return null;
  }

  // Control characters go first: removed later they could join the halves of a tag.
  let sanitized = input.replace(/[\x00-\x09\x0B-\x1F\x7F]/g, "");
  // Removing a tag can join the text around it into a new tag ("<scr<b>ipt>"), so repeat
  // until nothing changes. Every pass shortens the text, so this ends.
  for (let previous = ""; previous !== sanitized; ) {
    previous = sanitized;
    sanitized = sanitized.replace(HTML_COMMENT, "").replace(HTML_TAG, "");
  }
  sanitized = sanitized.trim();

  return sanitized || null;
}
