/**
 * Reads a text file's bytes as UTF-8 when they are valid UTF-8, otherwise as
 * Windows-1252: Excel on Windows still saves "CSV" in the ANSI code page, and
 * reading that as UTF-8 turns every ä and ö into a replacement character.
 */
export function decodeTextBytes(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try {
    // ignoreBOM false (default) strips a UTF-8 byte order mark.
    return new TextDecoder("utf-8", { fatal: true }).decode(view);
  } catch {
    return new TextDecoder("windows-1252").decode(view);
  }
}

/** `File.text()` with the same fallback. */
export async function readTextFile(file: Blob): Promise<string> {
  return decodeTextBytes(await file.arrayBuffer());
}
