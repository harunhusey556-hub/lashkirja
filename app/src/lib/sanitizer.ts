/**
 * Sanitizes user-provided text input before it is saved to the database.
 * - Strips all HTML tags
 * - Strips control characters (U+0000 to U+001F) except newlines (U+000A)
 * - Trims leading and trailing whitespace
 */
export function sanitizeText(input: string | null | undefined): string | null {
  if (!input || typeof input !== "string") {
    return null;
  }

  const sanitized = input
    .replace(/<[^>]*>?/gm, "") // Remove HTML tags
    .replace(/[\x00-\x09\x0B-\x1F\x7F]/g, "") // Remove control characters except newline
    .trim();

  return sanitized || null;
}
