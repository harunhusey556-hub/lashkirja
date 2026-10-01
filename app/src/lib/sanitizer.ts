/**
 * Sanitizes user-provided text input before it is saved to the database.
 * - Strips well-formed HTML tags and comments (a "<" followed by a letter up
 *   to its closing ">"); a lone "<" or ">" as in "a < b" or "<3" is ordinary
 *   text and is kept
 * - Strips control characters (U+0000 to U+001F) except newlines (U+000A)
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

  const sanitized = input
    .replace(HTML_COMMENT, "")
    .replace(HTML_TAG, "") // Remove HTML tags
    .replace(/[\x00-\x09\x0B-\x1F\x7F]/g, "") // Remove control characters except newline
    .trim();

  return sanitized || null;
}
