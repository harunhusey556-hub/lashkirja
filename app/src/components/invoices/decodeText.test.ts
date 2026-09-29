import { describe, expect, it } from "vitest";
import { decodeTextBytes } from "./decodeText";

describe("decodeTextBytes", () => {
  it("reads UTF-8 as UTF-8, dropping a byte order mark", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("nimi;kaupunki\nÄijä Oy;Hämeenlinna")]);
    expect(decodeTextBytes(bytes)).toBe("nimi;kaupunki\nÄijä Oy;Hämeenlinna");
  });

  it("falls back to Windows-1252 for an Excel ANSI export", () => {
    // "Äijä Oy;Hämeenlinna;Öljy" in Windows-1252: Ä=C4, ä=E4, Ö=D6.
    const text = "Äijä Oy;Hämeenlinna;Öljy €";
    const bytes = new Uint8Array(
      [...text].map((char) => (char === "€" ? 0x80 : char.charCodeAt(0)))
    );
    expect(decodeTextBytes(bytes)).toBe(text);
  });
});
